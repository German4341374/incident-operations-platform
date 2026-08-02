const state = { incidents: [], engineers: [], selected: null, page: 1 };
const statusOptions = ['Open', 'Investigating', 'Mitigating', 'Monitoring', 'Resolved', 'Closed'];

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      'x-actor': 'Web Administrator',
      ...options.headers,
    },
    ...options,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message || `Request failed with ${response.status}`);
  return data;
}

function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'Not recorded';
}

function escapeText(value) {
  const element = document.createElement('span');
  element.textContent = String(value ?? '');
  return element.innerHTML;
}

async function loadReadiness() {
  const pill = document.querySelector('#readiness');
  try {
    const status = await api('/ready');
    pill.textContent = `PostgreSQL ${status.dependencies.postgres} · Redis ${status.dependencies.redis}`;
    pill.className = 'health-pill ready';
  } catch {
    pill.textContent = 'Dependencies unavailable';
    pill.className = 'health-pill down';
  }
}

async function loadDashboard() {
  const data = await api('/api/dashboard');
  const metrics = [
    ['Total', data.total],
    ['Active', data.active],
    ['SLA breached', data.breached, 'alert'],
    ['Active P1', data.p1Active, data.p1Active ? 'alert' : ''],
    ['Resolved 24h', data.resolvedLast24Hours],
  ];
  document.querySelector('#metrics').innerHTML = metrics
    .map(
      ([label, value, style = '']) =>
        `<article class="metric ${style}"><span>${label}</span><strong>${value}</strong></article>`,
    )
    .join('');
}

async function loadEngineers() {
  const data = await api('/api/engineers');
  state.engineers = data.items;
}

async function loadIncidents() {
  const form = new FormData(document.querySelector('#filters'));
  const params = new URLSearchParams({ page: String(state.page), pageSize: '25' });
  for (const [key, value] of form.entries()) if (value) params.set(key, value);
  const data = await api(`/api/incidents?${params}`);
  state.incidents = data.items;
  const list = document.querySelector('#incident-list');
  list.innerHTML = state.incidents.length
    ? state.incidents
        .map(
          (
            incident,
          ) => `<button class="incident-row ${state.selected?.id === incident.id ? 'selected' : ''}" data-id="${incident.id}">
            <span class="priority ${incident.priority.toLowerCase()}">${incident.priority}</span>
            <span><strong>${escapeText(incident.title)}</strong><small>${escapeText(incident.incidentNumber)} · ${escapeText(incident.assigneeName || 'Unassigned')}</small></span>
            <span><time>${formatDate(incident.updatedAt)}</time><span class="status">${escapeText(incident.status)}</span></span>
          </button>`,
        )
        .join('')
    : '<div class="empty-state"><p>No incidents match these filters.</p></div>';
  list
    .querySelectorAll('[data-id]')
    .forEach((button) =>
      button.addEventListener('click', () => void showIncident(button.dataset.id)),
    );
}

function timelineHtml(items) {
  return items
    .map((item) => {
      const detail =
        item.metadata.body ||
        item.metadata.type ||
        (item.metadata.from && `${item.metadata.from} → ${item.metadata.to}`) ||
        '';
      return `<article class="timeline-item"><strong>${escapeText(item.eventType.replaceAll('_', ' '))}</strong><p>${escapeText(detail)}</p><time>${escapeText(item.actor)} · ${formatDate(item.occurredAt)}</time></article>`;
    })
    .join('');
}

async function showIncident(id) {
  const [detail, timeline] = await Promise.all([
    api(`/api/incidents/${id}`),
    api(`/api/incidents/${id}/timeline`),
  ]);
  state.selected = detail.incident;
  const fragment = document.querySelector('#detail-template').content.cloneNode(true);
  const set = (field, value) => {
    fragment.querySelector(`[data-field="${field}"]`).textContent = value;
  };
  set('priority', detail.incident.priority);
  fragment.querySelector('[data-field="priority"]').className =
    `priority ${detail.incident.priority.toLowerCase()}`;
  set('status', detail.incident.status);
  fragment.querySelector('[data-field="status"]').className = 'status';
  set('number', detail.incident.incidentNumber);
  set('title', detail.incident.title);
  set('description', detail.incident.description);
  set('version', `Version ${detail.incident.version}`);
  set('firstResponseDeadline', formatDate(detail.incident.firstResponseDeadline));
  set('resolutionDeadline', formatDate(detail.incident.resolutionDeadline));
  set('assigneeName', detail.incident.assigneeName || 'Unassigned');
  fragment.querySelector('[data-field="timeline"]').innerHTML = timelineHtml(timeline.items);

  const updateForm = fragment.querySelector('[data-form="update"]');
  updateForm.elements.status.innerHTML = statusOptions
    .map(
      (status) =>
        `<option ${status === detail.incident.status ? 'selected' : ''}>${status}</option>`,
    )
    .join('');
  updateForm.elements.assigneeId.innerHTML = `<option value="">Unassigned</option>${state.engineers.map((engineer) => `<option value="${engineer.id}" ${engineer.id === detail.incident.assigneeId ? 'selected' : ''}>${escapeText(engineer.name)}</option>`).join('')}`;
  updateForm.addEventListener('submit', updateIncident);
  fragment.querySelector('[data-form="comment"]').addEventListener('submit', addComment);
  fragment.querySelector('[data-form="link"]').addEventListener('submit', linkIncident);
  fragment.querySelector('[data-action="audit"]').addEventListener('click', showAudit);
  const panel = document.querySelector('#detail-panel');
  panel.replaceChildren(fragment);
  await loadIncidents();
}

function showDetailError(error) {
  document.querySelector('[data-field="error"]').textContent = error.message;
}

async function updateIncident(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(`/api/incidents/${state.selected.id}`, {
      method: 'PATCH',
      headers: { 'if-match': `"${state.selected.version}"` },
      body: JSON.stringify({
        status: form.elements.status.value,
        assigneeId: form.elements.assigneeId.value || null,
      }),
    });
    await Promise.all([loadDashboard(), showIncident(state.selected.id)]);
  } catch (error) {
    showDetailError(error);
  }
}

async function addComment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(`/api/incidents/${state.selected.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        author: 'Web Administrator',
        body: form.elements.body.value,
        type: form.elements.type.value,
      }),
    });
    form.reset();
    await showIncident(state.selected.id);
  } catch (error) {
    showDetailError(error);
  }
}

async function linkIncident(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(`/api/incidents/${state.selected.id}/links`, {
      method: 'POST',
      body: JSON.stringify({
        relatedIncidentId: form.elements.relatedIncidentId.value,
        actor: 'Web Administrator',
      }),
    });
    form.reset();
    await showIncident(state.selected.id);
  } catch (error) {
    showDetailError(error);
  }
}

async function showAudit() {
  try {
    const data = await api(`/api/incidents/${state.selected.id}/audit`);
    document.querySelector('[data-field="timeline"]').innerHTML = data.items
      .map(
        (item) =>
          `<article class="timeline-item"><strong>${escapeText(item.action)}</strong><p>Request ${escapeText(item.requestId)}</p><time>${escapeText(item.actor)} · ${formatDate(item.createdAt)}</time></article>`,
      )
      .join('');
  } catch (error) {
    showDetailError(error);
  }
}

document.querySelector('#filters').addEventListener('submit', (event) => {
  event.preventDefault();
  state.page = 1;
  void loadIncidents();
});
document
  .querySelector('#new-incident-button')
  .addEventListener('click', () => document.querySelector('#create-dialog').showModal());
document
  .querySelector('#close-dialog')
  .addEventListener('click', () => document.querySelector('#create-dialog').close());
document.querySelector('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form));
  try {
    const incident = await api('/api/incidents', { method: 'POST', body: JSON.stringify(payload) });
    document.querySelector('#create-dialog').close();
    form.reset();
    await Promise.all([loadDashboard(), loadIncidents()]);
    await showIncident(incident.id);
  } catch (error) {
    document.querySelector('#create-error').textContent = error.message;
  }
});

await Promise.all([loadReadiness(), loadDashboard(), loadEngineers(), loadIncidents()]);
