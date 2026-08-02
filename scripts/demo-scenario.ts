const baseUrl = process.env.API_URL ?? 'http://localhost:3000';

interface IncidentResponse {
  id: string;
  incidentNumber: string;
  version: number;
  resolutionDeadline: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-actor': 'Scenario Operator',
      ...init?.headers,
    },
  });
  const body = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body;
}

async function update(id: string, version: number, body: Record<string, unknown>) {
  return request<IncidentResponse>(`/api/incidents/${id}`, {
    method: 'PATCH',
    headers: { 'if-match': `"${version}"` },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  const engineers = await request<{ items: Array<{ id: string; name: string }> }>('/api/engineers');
  const engineer = engineers.items[0];
  if (!engineer) throw new Error('Seed an engineer before running the scenario');

  console.log('1. Creating a P1 incident');
  let incident = await request<IncidentResponse>('/api/incidents', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Checkout API unavailable in two regions',
      description: 'Synthetic employer demonstration: checkout requests return gateway failures.',
      priority: 'P1',
      reportedBy: 'Scenario Operator',
    }),
  });
  console.log(`   ${incident.incidentNumber} created`);

  console.log(`2. Assigning ${engineer.name} and moving to Investigating`);
  incident = await update(incident.id, incident.version, {
    assigneeId: engineer.id,
    status: 'Investigating',
  });

  const waitMilliseconds = new Date(incident.resolutionDeadline).getTime() - Date.now() + 1500;
  if (waitMilliseconds > 120_000) {
    throw new Error(
      'The real P1 resolution SLA is four hours. Restart API and worker with SLA_TIME_FACTOR=0.005 for the accelerated local scenario.',
    );
  }
  console.log(
    `3. Waiting ${Math.max(0, Math.ceil(waitMilliseconds / 1000))} seconds for automatic resolution escalation`,
  );
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMilliseconds)));
  let timeline = await request<{ items: Array<{ eventType: string }> }>(
    `/api/incidents/${incident.id}/timeline`,
  );
  if (!timeline.items.some((event) => event.eventType === 'sla_escalated')) {
    throw new Error('The automatic escalation did not appear in the timeline');
  }

  console.log('4. Adding mitigation and moving to Mitigating');
  await request(`/api/incidents/${incident.id}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      author: engineer.name,
      type: 'mitigation',
      body: 'Shifted traffic to the healthy region and reduced error rate.',
    }),
  });
  incident = await update(incident.id, incident.version, { status: 'Mitigating' });

  console.log('5. Moving to Monitoring');
  incident = await update(incident.id, incident.version, { status: 'Monitoring' });

  console.log('6. Resolving and closing the incident');
  incident = await update(incident.id, incident.version, { status: 'Resolved' });
  incident = await update(incident.id, incident.version, { status: 'Closed' });

  console.log('7. Reading timeline and audit log');
  [timeline] = await Promise.all([
    request<{ items: Array<{ eventType: string }> }>(`/api/incidents/${incident.id}/timeline`),
    request<{ items: unknown[] }>(`/api/incidents/${incident.id}/audit`).then((audit) => {
      console.log(`   Audit records: ${audit.items.length}`);
      return audit;
    }),
  ]);
  console.log(`   Timeline events: ${timeline.items.length}`);
  console.log(`Scenario complete: ${baseUrl}/api/incidents/${incident.id}`);
}

await main();
