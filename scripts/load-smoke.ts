import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.API_URL ?? 'http://127.0.0.1:3000';
const duration = Number(process.env.LOAD_DURATION_SECONDS ?? 3);
const connections = Number(process.env.LOAD_CONNECTIONS ?? 10);

interface SmokeResult {
  scenario: string;
  requestsPerSecond: number;
  latencyP50Ms: number;
  latencyP99Ms: number;
  totalRequests: number;
  errors: number;
  non2xx: number;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * percentileValue) - 1,
  );
  return Math.round(sortedValues[index] ?? 0);
}

async function runScenario(
  scenario: string,
  route: string,
  request: RequestInit = {},
  scenarioConnections = connections,
): Promise<SmokeResult> {
  const startedAt = performance.now();
  const deadline = startedAt + duration * 1000;
  const latencies: number[] = [];
  let totalRequests = 0;
  let errors = 0;
  let non2xx = 0;

  async function client(): Promise<void> {
    while (performance.now() < deadline) {
      const requestStartedAt = performance.now();
      try {
        const response = await fetch(`${baseUrl}${route}`, {
          ...request,
          signal: AbortSignal.timeout(3000),
        });
        await response.arrayBuffer();
        if (!response.ok) non2xx += 1;
      } catch {
        errors += 1;
      } finally {
        totalRequests += 1;
        latencies.push(performance.now() - requestStartedAt);
      }
    }
  }

  await Promise.all(Array.from({ length: scenarioConnections }, () => client()));
  latencies.sort((left, right) => left - right);
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  return {
    scenario,
    requestsPerSecond: Math.round(totalRequests / elapsedSeconds),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP99Ms: percentile(latencies, 0.99),
    totalRequests,
    errors,
    non2xx,
  };
}

async function main(): Promise<void> {
  const health = await fetch(`${baseUrl}/ready`);
  if (!health.ok) throw new Error(`Target is not ready: HTTP ${health.status}`);

  const scenarios = [
    await runScenario('liveness', '/health'),
    await runScenario('incident-list', '/api/incidents?pageSize=20'),
    await runScenario('dashboard', '/api/dashboard'),
    await runScenario(
      'incident-create',
      '/api/incidents',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-actor': 'Load Smoke' },
        body: JSON.stringify({
          title: 'Synthetic load smoke incident',
          description:
            'Synthetic request used only to verify the main write path under light concurrency.',
          priority: 'P4',
          reportedBy: 'Load Smoke',
        }),
      },
      Math.min(connections, 5),
    ),
  ];

  const failures = scenarios.filter(
    (scenario) => scenario.errors > 0 || scenario.non2xx > 0 || scenario.latencyP99Ms > 2000,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    environment: process.env.CI ? 'GitHub Actions ubuntu-24.04' : 'local',
    configuration: { durationSecondsPerScenario: duration, connections },
    passCriteria: { errors: 0, non2xx: 0, maximumP99Milliseconds: 2000 },
    scenarios,
    passed: failures.length === 0,
  };
  const artifacts = path.resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'load-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

await main();
