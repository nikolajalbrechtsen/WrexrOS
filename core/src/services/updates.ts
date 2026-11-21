/** Update checks against GitHub releases plus a simulated install job. */
import { config } from '../config.ts';
import { getSetting, setSetting } from '../db.ts';
import { logger } from '../logger.ts';
import { coreVersion } from '../system.ts';
import { id, semverCompare } from '../util.ts';
import { listCatalog } from './apps.ts';
import { getUpdatesSettings } from './settings.ts';

export const RELEASES_URL =
  'https://api.github.com/repos/nikolajalbrechtsen/WrexrOS/releases/latest';
const DEMO_LATEST = '0.2.0';

export interface UpdateCheck {
  current: string;
  latest: string;
  updateAvailable: boolean;
  releaseUrl: string;
  publishedAt: string | null;
  error?: string;
}

export function currentVersion(): string {
  return coreVersion(config);
}

export async function checkUpdates(): Promise<UpdateCheck> {
  const current = currentVersion();
  if (config.demoMode) {
    return {
      current,
      latest: DEMO_LATEST,
      updateAvailable: semverCompare(DEMO_LATEST, current) > 0,
      releaseUrl: `${config.updateRepo}/releases/tag/v${DEMO_LATEST}`,
      publishedAt: '2026-11-01T10:00:00Z',
    };
  }
  try {
    const response = await fetch(RELEASES_URL, {
      headers: {
        'User-Agent': 'WrexrOS',
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const release = (await response.json()) as Record<string, unknown>;
    const latest = String(release.tag_name ?? current).replace(/^v/i, '');
    return {
      current,
      latest,
      updateAvailable: semverCompare(latest, current) > 0,
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : config.updateRepo,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Update check failed', { error: message });
    return {
      current,
      latest: current,
      updateAvailable: false,
      releaseUrl: config.updateRepo,
      publishedAt: null,
      error: message,
    };
  }
}

interface UpdateJob {
  jobId: string;
  version: string;
  state: 'running' | 'success' | 'failed';
  progress: number;
  message: string;
  startedAt: number;
}

function defaultJob(): UpdateJob {
  return {
    jobId: 'none',
    version: currentVersion(),
    state: 'success',
    progress: 100,
    message: 'No update job has been started',
    startedAt: 0,
  };
}

export function installUpdate(version?: string): { jobId: string } {
  const job: UpdateJob = {
    jobId: id(),
    version: version ?? DEMO_LATEST,
    state: 'running',
    progress: 0,
    message: 'Preparing update',
    startedAt: Date.now(),
  };
  setSetting('updates.job', job);
  return { jobId: job.jobId };
}

export function updateStatus(): {
  state: string;
  progress: number;
  message: string;
  jobId: string;
  version: string;
} {
  const job: UpdateJob = { ...defaultJob(), ...getSetting<Partial<UpdateJob>>('updates.job', {}) };
  if (job.state === 'running') {
    const progress = Math.min(100, Math.round(((Date.now() - job.startedAt) / 12_000) * 100));
    job.progress = progress;
    job.message =
      progress < 30
        ? 'Downloading update'
        : progress < 70
          ? 'Verifying signatures'
          : progress < 100
            ? 'Installing packages'
            : 'Update complete';
    if (progress >= 100) job.state = 'success';
    setSetting('updates.job', job);
  }
  return {
    state: job.state,
    progress: job.progress,
    message: job.message,
    jobId: job.jobId,
    version: job.version,
  };
}

export function appUpdates(): Array<Record<string, unknown>> {
  return listCatalog().apps
    .filter((app) => app.updateAvailable)
    .map((app) => ({ id: app.id, name: app.name, version: app.version }));
}

export function repoInfo(): Record<string, unknown> {
  return {
    repository: 'nikolajalbrechtsen/WrexrOS',
    url: config.updateRepo,
    channel: getUpdatesSettings().channel,
    lastSync: getSetting<number | null>('appReposSyncedAt', null),
    status: getUpdatesSettings().syncStatus,
  };
}
