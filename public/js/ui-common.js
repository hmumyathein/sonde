/** Reusable UI pieces: key/value grids, modals, toasts, confirm/prompt. */
import { el, clear, $, uid, bytesToBase64 } from './utils.js';

/* ------------------------------------------------------------------ *
 * Editable key/value grid
 * ------------------------------------------------------------------ */

/**
 * Build a Postman-style key/value table.
 *
 * The last row is always a "draft" row that is not yet part of `rows`. Typing
 * into it promotes it in place and appends a fresh draft — so the grid grows
 * as you type without a re-render stealing focus.
 *
 * @param {object[]} rows        mutated in place
 * @param {object}   opts
 * @param {Function} opts.onChange     called after every edit
 * @param {boolean}  opts.description  show the description column
 * @param {boolean}  opts.files        allow per-row text/file switching
 * @param {string}   opts.keyLabel     header for the key column
 */
export function kvTable(rows, opts = {}) {
  const {
    onChange = () => {},
    description = true,
    files = false,
    keyLabel = 'Key',
    valueLabel = 'Value',
    keyPlaceholder = 'key',
    valuePlaceholder = 'value',
    readOnly = false,
  } = opts;

  const table = el('table', { class: 'kv' });
  const thead = el('tr', {},
    el('th', { style: { width: '38px' }, title: 'Include this row in the request' }, ''),
    el('th', {}, keyLabel),
    el('th', {}, valueLabel),
    description ? el('th', { style: { width: '26%' } }, 'Description') : null,
    el('th', { style: { width: '34px' } })
  );
  table.append(el('thead', {}, thead));
  const tbody = el('tbody');
  table.append(tbody);

  const makeRow = (row, isDraft) => {
    const tr = el('tr', { class: isDraft ? 'is-draft' : row.enabled === false ? 'is-disabled' : '' });

    const promote = () => {
      if (!isDraft) return;
      isDraft = false;
      rows.push(row);
      tr.classList.remove('is-draft');
      tbody.append(makeRow(blank(), true));
    };

    const bind = (input, field) => {
      input.addEventListener('input', () => {
        row[field] = input.value;
        promote();
        onChange();
      });
      return input;
    };

    // enable / disable
    const check = el('input', {
      type: 'checkbox',
      checked: row.enabled !== false,
      disabled: readOnly,
      onchange: (e) => {
        row.enabled = e.target.checked;
        tr.classList.toggle('is-disabled', !e.target.checked);
        onChange();
      },
    });
    tr.append(el('td', { class: 'kv-check' }, isDraft ? '' : check));

    // key
    tr.append(el('td', {}, bind(el('input', {
      type: 'text', value: row.key ?? '', placeholder: keyPlaceholder,
      spellcheck: false, readOnly,
    }), 'key')));

    // value — text, or a file picker for form-data file rows
    const valueCell = el('td');
    const renderValue = () => {
      clear(valueCell);
      if (files && row.type === 'file') {
        const label = el('span', { class: 'file-name' }, row.fileName || 'no file selected');
        const picker = el('input', {
          type: 'file',
          style: { display: 'none' },
          onchange: async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            row.fileName = file.name;
            row.contentType = file.type || 'application/octet-stream';
            row.data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
            label.textContent = `${file.name} (${file.size} B)`;
            promote();
            onChange();
          },
        });
        valueCell.append(el('div', { class: 'kv-file' },
          el('button', { class: 'btn btn-sm', onclick: () => picker.click() }, 'Choose file'),
          label, picker));
      } else {
        valueCell.append(bind(el('input', {
          type: 'text', value: row.value ?? '', placeholder: valuePlaceholder,
          spellcheck: false, readOnly,
        }), 'value'));
      }
    };
    renderValue();
    tr.append(valueCell);

    if (description) {
      if (files) {
        // The description column doubles as the text/file switch for form-data.
        tr.append(el('td', {},
          el('select', {
            style: { border: 'none', background: 'transparent', width: '100%' },
            value: row.type ?? 'text',
            onchange: (e) => {
              row.type = e.target.value;
              renderValue();
              promote();
              onChange();
            },
          }, el('option', { value: 'text' }, 'Text'), el('option', { value: 'file' }, 'File'))
        ));
      } else {
        tr.append(el('td', {}, bind(el('input', {
          type: 'text', value: row.description ?? '', placeholder: 'description',
          spellcheck: false, readOnly,
        }), 'description')));
      }
    }

    // delete
    tr.append(el('td', { class: 'kv-del' }, isDraft || readOnly ? '' : el('button', {
      class: 'icon-btn', title: 'Remove row',
      onclick: () => {
        const idx = rows.indexOf(row);
        if (idx > -1) rows.splice(idx, 1);
        tr.remove();
        onChange();
      },
    }, '✕')));

    return tr;
  };

  const blank = () => ({ id: uid('kv'), key: '', value: '', description: '', enabled: true, type: files ? 'text' : undefined });

  for (const row of rows) tbody.append(makeRow(row, false));
  if (!readOnly) tbody.append(makeRow(blank(), true));

  return table;
}

/** Read-only two-column table, for response headers. */
export function readonlyTable(pairs, [keyLabel, valueLabel] = ['Key', 'Value']) {
  const tbody = el('tbody', {}, pairs.map(([k, v]) => el('tr', {},
    el('td', {}, el('input', { type: 'text', value: k, readOnly: true })),
    el('td', {}, el('input', { type: 'text', value: v, readOnly: true }))
  )));
  return el('table', { class: 'kv' },
    el('thead', {}, el('tr', {}, el('th', {}, keyLabel), el('th', {}, valueLabel))),
    tbody);
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

let closeCurrentModal = null;

export function openModal({ title, body, footer = [], onClose = null, width = null }) {
  const backdrop = $('#modal-backdrop');
  const modal = $('#modal');
  $('#modal-title').textContent = title;
  clear($('#modal-body')).append(body);
  clear($('#modal-foot')).append(...footer);
  if (width) modal.style.width = width;
  backdrop.hidden = false;

  closeCurrentModal = () => {
    backdrop.hidden = true;
    modal.style.width = '';
    closeCurrentModal = null;
    onClose?.();
  };
  return closeCurrentModal;
}

export function closeModal() {
  closeCurrentModal?.();
}

export function isModalOpen() {
  return !$('#modal-backdrop').hidden;
}

/**
 * Text prompt. Resolves with the string, or null if cancelled.
 *
 * A dialog can finish two ways: the user picks a button, or it gets dismissed
 * (✕ / Escape / backdrop) which fires onClose. closeModal() itself triggers
 * onClose on the way out, so a button press would otherwise settle the promise
 * twice — cancel-first, silently discarding the real answer. `settled` makes
 * the first outcome the only one.
 */
export function promptText({ title, label = '', value = '', placeholder = '', confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, placeholder });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      closeModal();
    };
    const body = el('div', {},
      label ? el('div', { class: 'field-hint', style: { margin: '0 0 8px' } }, label) : null,
      input);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value.trim() || null);
    });
    openModal({
      title,
      body,
      footer: [
        el('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: () => finish(input.value.trim() || null) }, confirmLabel),
      ],
      onClose: () => finish(null),
      width: '440px',
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/** Yes/no confirmation. Resolves true only on the confirm button. */
export function confirmAction({ title, message, confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    // See promptText: settle once, so closeModal()'s onClose can't overwrite
    // a real answer with the dismissal default.
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      closeModal();
    };
    openModal({
      title,
      body: el('p', { style: { margin: 0, lineHeight: '1.7' } }, message),
      footer: [
        el('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        el('button', {
          class: danger ? 'btn btn-primary' : 'btn',
          style: danger ? { background: 'var(--red)', borderColor: 'var(--red)' } : {},
          onclick: () => finish(true),
        }, confirmLabel),
      ],
      onClose: () => finish(false),
      width: '440px',
    });
  });
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

export function toast(message, kind = 'info', ms = 3200) {
  const node = el('div', { class: `toast toast-${kind}` }, message);
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
}
