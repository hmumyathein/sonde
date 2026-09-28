//
//  Sonde — native macOS shell.
//
//  Runs the node server as a child process and shows it in a WKWebView that
//  this app owns. That ownership is the whole point: the window belongs to
//  Sonde, so the Dock icon activates it, ⌘Tab finds it, and no browser is
//  involved. The server is bound to the app's lifetime and dies with it.
//

import Cocoa
import WebKit

// MARK: - Locating node

/// Finder gives an app a bare PATH, so node is rarely on it. Look where the
/// installers actually put it, preferring the newest version manager install.
func findNode() -> URL? {
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser.path

    let fixed = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "\(home)/.local/bin/node",
        "/opt/local/bin/node",
    ]
    for path in fixed where fm.isExecutableFile(atPath: path) {
        return URL(fileURLWithPath: path)
    }

    let managers = [
        ("\(home)/.nvm/versions/node", "bin/node"),
        ("\(home)/.fnm/node-versions", "installation/bin/node"),
        ("\(home)/.volta/tools/image/node", "bin/node"),
    ]
    for (root, suffix) in managers {
        guard let versions = try? fm.contentsOfDirectory(atPath: root) else { continue }
        // Newest first, by version-ish ordering.
        let sorted = versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
        for version in sorted {
            let candidate = "\(root)/\(version)/\(suffix)"
            if fm.isExecutableFile(atPath: candidate) { return URL(fileURLWithPath: candidate) }
        }
    }
    return nil
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var serverStdin: Pipe?
    private var didLoad = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        makeWindow()
        startServer()
    }

    // Quitting closes the window; closing the window quits.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    /// Re-opening from the Dock brings the window back rather than doing nothing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: Window

    private func makeWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // The page is our own local server; let it use the full modern surface.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Sonde"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 780, height: 480)
        window.contentView = webView
        window.setFrameAutosaveName("SondeMainWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: Server

    private func startServer() {
        guard let node = findNode() else {
            fail(title: "Node.js not found",
                 message: "Sonde needs Node.js 18 or newer.\n\nInstall it from nodejs.org, or with:\n  brew install node")
            return
        }

        let resources = Bundle.main.resourceURL!
        let serverJS = resources.appendingPathComponent("app/server.js")

        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Sonde")
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)

        let process = Process()
        process.executableURL = node
        process.arguments = [serverJS.path, "--embedded"]
        var env = ProcessInfo.processInfo.environment
        env["SONDE_DATA_DIR"] = support.path
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        // Held open for the app's lifetime. The server watches this for EOF and
        // exits when we die, so a crash or force-quit can't leave it orphaned.
        let stdinPipe = Pipe()
        process.standardInput = stdinPipe
        serverStdin = stdinPipe

        var buffer = Data()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            buffer.append(chunk)
            guard let text = String(data: buffer, encoding: .utf8) else { return }

            for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
                guard line.hasPrefix("SONDE_LISTENING ") else { continue }
                let url = String(line.dropFirst("SONDE_LISTENING ".count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                pipe.fileHandleForReading.readabilityHandler = nil
                DispatchQueue.main.async { self?.load(url) }
                return
            }
        }

        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.didLoad else { return }
                self.fail(title: "Sonde couldn't start",
                          message: "The server exited with code \(proc.terminationStatus).")
            }
        }

        do {
            try process.run()
            server = process
        } catch {
            fail(title: "Sonde couldn't start", message: error.localizedDescription)
        }
    }

    private func stopServer() {
        server?.terminationHandler = nil
        server?.terminate()
        // Closing stdin is the belt-and-braces path: even if terminate() is
        // missed, the server sees EOF and exits on its own.
        try? serverStdin?.fileHandleForWriting.close()
        serverStdin = nil
        server = nil
    }

    private func load(_ url: String) {
        guard let target = URL(string: url) else { return }
        didLoad = true
        webView.load(URLRequest(url: target))
    }

    private func fail(title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    // MARK: Menu

    @objc private func reload() { webView.reload() }

    /// Without an Edit menu, ⌘C/⌘V/⌘A don't reach the web view at all.
    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Sonde", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Sonde", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Sonde", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }
}

// MARK: - Navigation, downloads, file pickers

extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Save / Export use `<a download>`; route those to a real save panel.
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // Anything pointing off our own server opens in the user's browser.
        if let url = navigationAction.request.url,
           navigationAction.navigationType == .linkActivated,
           url.host != "127.0.0.1", url.host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
}

extension AppDelegate: WKDownloadDelegate {
    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.begin { result in
            completionHandler(result == .OK ? panel.url : nil)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSSound.beep()
    }
}

extension AppDelegate: WKUIDelegate {
    /// Needed for the form-data and binary body file pickers.
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.begin { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Sonde"
        alert.informativeText = message
        alert.runModal()
        completionHandler()
    }
}

// MARK: - Entry point

// `--probe` lets the build check whether this binary is actually allowed to run
// on this machine before committing the bundle to it. Exits before touching the
// UI or spawning anything.
if CommandLine.arguments.contains("--probe") {
    print("SONDE_PROBE_OK")
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
