const contactForm = document.querySelector('#contact-form');
const recordsBody = document.querySelector('#records-body');
const rowCount = document.querySelector('#row-count');
const statusLabel = document.querySelector('#status-label');
const statusPill = document.querySelector('#database-status');
const tableMessage = document.querySelector('#table-message');
const formTitle = document.querySelector('#form-title');
const submitButton = document.querySelector('#submit-button');
const cancelEditButton = document.querySelector('#cancel-edit');
const postcodeInput = document.querySelector('#postcode');
const placeSelect = document.querySelector('#plaats');
const logoutButton = document.querySelector('#logout-button');
const liveRegion = document.querySelector('#live-region');
const confirmDialog = document.querySelector('#confirm-dialog');
const confirmText = document.querySelector('#confirm-text');
let editingId = null;
let placeLookupId = 0;
let lastRenderedId = null;
let lastContacts = [];

function announce(message) {
  liveRegion.textContent = '';
  window.setTimeout(() => {
    liveRegion.textContent = message;
  }, 40);
}

function showMessage(message, isError = false, isSuccess = false) {
  tableMessage.textContent = message;
  tableMessage.classList.toggle('is-error', isError);
  tableMessage.classList.toggle('is-success', isSuccess);
  tableMessage.hidden = false;
  announce(message);
}

function setFieldError(name, message) {
  const field = contactForm.elements[name];
  const error = document.querySelector(`#${name}-error`);
  if (!field || !error) return;

  if (message) {
    field.classList.add('is-invalid');
    field.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
  } else {
    field.classList.remove('is-invalid');
    field.removeAttribute('aria-invalid');
    error.textContent = '';
    error.hidden = true;
  }
}

function clearFieldErrors() {
  for (const name of ['naam', 'voornaam', 'adres', 'postcode', 'plaats']) {
    setFieldError(name, '');
  }
}

function validateForm() {
  clearFieldErrors();
  let firstInvalid = null;

  for (const name of ['naam', 'voornaam', 'adres']) {
    const value = contactForm.elements[name].value.trim();
    if (!value) {
      setFieldError(name, 'Dit veld is verplicht.');
      firstInvalid = firstInvalid || contactForm.elements[name];
    }
  }

  const postcode = contactForm.elements.postcode.value.trim();
  const plaats = contactForm.elements.plaats.value;
  if (Boolean(postcode) !== Boolean(plaats)) {
    setFieldError(postcode ? 'plaats' : 'postcode', 'Vul postcode en plaats samen in.');
    firstInvalid = firstInvalid || contactForm.elements[postcode ? 'plaats' : 'postcode'];
  }
  if (postcode && !/^\d{4}$/.test(postcode)) {
    setFieldError('postcode', 'Een postcode bestaat uit vier cijfers.');
    firstInvalid = firstInvalid || contactForm.elements.postcode;
  }

  if (firstInvalid) {
    firstInvalid.focus();
    return false;
  }
  return true;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (response.status === 204) return null;

  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error('Je sessie is verlopen. Log opnieuw in.');
  }

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || 'Er ging iets mis.');
  }
  return result;
}

function makeActionButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function renderContacts(contacts) {
  recordsBody.replaceChildren();

  if (contacts.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-state';
    cell.textContent = 'Er zijn nog geen contacten. Voeg hierboven het eerste contact toe.';
    row.append(cell);
    recordsBody.append(row);
  } else {
    contacts.forEach((contact) => {
      const row = document.createElement('tr');
      row.dataset.id = String(contact.id);
      if (contact.id === lastRenderedId) row.classList.add('is-new');
      if (contact.id === editingId) row.classList.add('is-editing');
      for (const value of [
        contact.naam,
        contact.voornaam,
        contact.adres,
        contact.postcode || '—',
        contact.plaats || '—',
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }

      const actions = document.createElement('td');
      actions.className = 'row-actions';
      actions.append(
        makeActionButton('Wijzigen', 'outline edit-button', () => beginEdit(contact)),
        makeActionButton('Verwijderen', 'outline delete-button', () => deleteContact(contact)),
      );
      row.append(actions);
      recordsBody.append(row);
    });
  }

  rowCount.textContent = `${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacten'}`;
}

async function loadContacts() {
  statusLabel.textContent = 'Verbinden…';
  statusPill.classList.remove('is-error');
  statusPill.classList.add('is-busy');
  try {
    const { contacts } = await request('/api/contacts');
    lastContacts = contacts;
    renderContacts(contacts);
    statusLabel.textContent = 'Opgeslagen';
    tableMessage.hidden = true;
  } catch (error) {
    statusLabel.textContent = 'Verbinding mislukt';
    statusPill.classList.add('is-error');
    rowCount.textContent = 'Niet beschikbaar';
    showMessage(error.message, true);
  } finally {
    statusPill.classList.remove('is-busy');
  }
}

function resetForm() {
  contactForm.reset();
  clearFieldErrors();
  void loadPlaces('');
  editingId = null;
  formTitle.textContent = 'Contact toevoegen';
  submitButton.textContent = 'Contact toevoegen';
  cancelEditButton.hidden = true;
  renderContacts(lastContacts);
}

async function beginEdit(contact) {
  editingId = contact.id;
  clearFieldErrors();
  contactForm.elements.naam.value = contact.naam;
  contactForm.elements.voornaam.value = contact.voornaam;
  contactForm.elements.adres.value = contact.adres;
  postcodeInput.value = contact.postcode || '';
  await loadPlaces(postcodeInput.value, contact.plaats || '');
  formTitle.textContent = 'Contact wijzigen';
  submitButton.textContent = 'Wijzigingen opslaan';
  cancelEditButton.hidden = false;
  contactForm.elements.naam.focus();
  renderContacts(lastContacts);
}

function setPlaceOptions(message, places = [], selectedPlace = '') {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = message;
  const options = places.map((place) => {
    const option = document.createElement('option');
    option.value = place;
    option.textContent = place;
    return option;
  });
  placeSelect.replaceChildren(placeholder, ...options);
  placeSelect.disabled = places.length === 0;
  if (places.includes(selectedPlace)) placeSelect.value = selectedPlace;
}

async function loadPlaces(postcode, selectedPlace = '') {
  const lookupId = ++placeLookupId;
  if (!/^\d{4}$/.test(postcode)) {
    setPlaceOptions('Vul eerst een postcode in');
    return;
  }

  setPlaceOptions('Plaatsen laden…');
  try {
    const { places } = await request(`/api/postal-places/${encodeURIComponent(postcode)}`);
    if (lookupId !== placeLookupId) return;
    setPlaceOptions(places.length ? 'Selecteer een plaats' : 'Geen plaatsen gevonden', places, selectedPlace);
  } catch (error) {
    if (lookupId !== placeLookupId) return;
    setPlaceOptions('Plaatsen niet beschikbaar');
    showMessage(error.message, true);
  }
}

function askConfirmation(message) {
  if (typeof confirmDialog.showModal !== 'function') {
    return Promise.resolve(window.confirm(message));
  }

  confirmText.textContent = message;
  confirmDialog.returnValue = '';
  confirmDialog.showModal();

  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => {
      resolve(confirmDialog.returnValue === 'confirm');
    }, { once: true });
  });
}

async function deleteContact(contact) {
  const fullName = `${contact.voornaam} ${contact.naam}`;
  const confirmed = await askConfirmation(`${fullName} wordt permanent verwijderd. Dit kan niet ongedaan worden gemaakt.`);
  if (!confirmed) return;

  try {
    await request(`/api/contacts/${contact.id}`, { method: 'DELETE' });
    if (editingId === contact.id) resetForm();
    showMessage(`${fullName} is verwijderd.`, false, true);
    await loadContacts();
  } catch (error) {
    showMessage(error.message, true);
  }
}

contactForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!validateForm()) {
    announce('Het formulier bevat fouten.');
    return;
  }

  const contact = Object.fromEntries(new FormData(contactForm));
  const path = editingId === null ? '/api/contacts' : `/api/contacts/${editingId}`;
  const method = editingId === null ? 'POST' : 'PUT';
  const wasCreating = editingId === null;

  submitButton.disabled = true;
  try {
    const { contact: saved } = await request(path, { method, body: JSON.stringify(contact) });
    if (wasCreating) lastRenderedId = saved?.id ?? null;
    showMessage(wasCreating ? 'Contact toegevoegd.' : 'Wijzigingen opgeslagen.', false, true);
    resetForm();
    await loadContacts();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

cancelEditButton.addEventListener('click', resetForm);
postcodeInput.addEventListener('input', () => {
  void loadPlaces(postcodeInput.value.trim());
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await fetch('/api/session', { method: 'DELETE' });
  } finally {
    window.location.replace('/login');
  }
});

loadContacts();
