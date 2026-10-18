'use strict';

// Automatische Updates für die INSTALLIERTE App (Squirrel.Windows) über den kostenlosen Dienst update.electronjs.org.
// Voraussetzungen laut github.com/electron/update.electronjs.org: öffentliches GitHub-Repo, Builds als GitHub-Releases,
// Code-Signatur nur für macOS/MSIX nötig (nicht für Squirrel.Windows).
// Übertragen wird dabei nur: Repo, Plattform, Architektur und App-Version (keine persönlichen Daten).

// Alle 15 Minuten (Wunsch JoniMoni) – der Dienst antwortet aus dem Cache, geladen wird nur bei neuer Version.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
// Erster Start nach der Installation: Squirrel hält kurz eine Sperre → etwas später prüfen statt gar nicht
const FIRSTRUN_DELAY_MS = 60 * 1000;

/** "github:owner/name", "owner/name" oder "https://github.com/owner/name(.git)" → "owner/name" */
function parseRepo(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  const m = /^(?:github:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(raw) || /github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(raw);
  if (!m || m[1] === 'DEIN-GITHUB-NAME') return null;
  return `${m[1]}/${m[2]}`;
}

function feedUrl(repo, platform, arch, version) {
  return `https://update.electronjs.org/${repo}/${platform}-${arch}/${version}`;
}

/**
 * @param {object} o
 * @param {import('electron').AutoUpdater} o.autoUpdater
 * @param {boolean} o.isPackaged
 * @param {string} o.version  App-Version (semver)
 * @param {string|null} o.repo  "owner/name"
 * @param {(type:string, payload:any)=>void} o.emit
 */
/** Direkt vom GitHub-Release laden (Squirrel holt …/RELEASES und die .nupkg daneben). */
function directFeedUrl(repo, latestVersion) {
  return `https://github.com/${repo}/releases/download/v${latestVersion}`;
}

/** Automatische Release-Notizen („* Titel by @x in https://…/pull/31“) → kurze Zeilen „Titel (#31)“. */
function releaseNotes(body) {
  return String(body || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[*-] /.test(l))
    .map((l) => {
      const pr = /\/pull\/(\d+)/.exec(l)?.[1];
      const text = l
        .replace(/^[*-] /, '')
        .replace(/ by @[\w-]+( in https?:\/\/\S+)?$/, '')
        .replace(/https?:\/\/\S+/g, '')
        .trim();
      return (pr ? `${text} (#${pr})` : text).slice(0, 160);
    })
    .filter(Boolean)
    .slice(0, 20);
}

/** Commits aus dem Vergleich: neueste zuerst, Merge-Commits als PR-Titel. */
function commitList(commits) {
  return (Array.isArray(commits) ? commits : [])
    .map((c) => {
      const msg = String(c?.commit?.message || '');
      const lines = msg.split('\n').map((l) => l.trim()).filter(Boolean);
      const merge = /^Merge pull request #(\d+)/.exec(lines[0] || '');
      const title = merge ? `${lines[1] || 'Pull Request'} (#${merge[1]})` : lines[0] || '';
      return { sha: String(c?.sha || '').slice(0, 7), title: title.slice(0, 140), date: Date.parse(c?.commit?.author?.date) || null, author: String(c?.commit?.author?.name || '').slice(0, 60), merge: Boolean(merge) };
    })
    .filter((c) => c.title && !/^Co-Authored-By/i.test(c.title))
    .reverse()
    .slice(0, 40);
}

/** SemVer X.Y.Z vergleichen: <0, 0, >0 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function createUpdater({ autoUpdater, isPackaged, version, repo, emit, platform = process.platform, arch = process.arch, argv = process.argv, schedule = setInterval, later = setTimeout, squirrelInstalled = true, now = () => Date.now(), fetchImpl = (...a) => fetch(...a) }) {
  let state = { state: 'idle', version };
  const set = (patch) => {
    state = { ...state, ...patch, at: Date.now() };
    emit('update', state);
    return state;
  };

  let reason = null;
  if (!isPackaged) reason = 'Updates gibt es nur in der installierten App. Im Quellcode: npm run update';
  else if (platform !== 'win32' && platform !== 'darwin') reason = 'Automatische Updates werden auf diesem System nicht unterstützt.';
  else if (!repo) reason = 'Kein GitHub-Repo eingetragen (package.json → "repository").';
  // ZIP-Version (entpackt statt installiert): Ohne Squirrel (Update.exe) kann sich die App nicht selbst aktualisieren
  else if (platform === 'win32' && !squirrelInstalled) reason = 'Diese Version wurde aus der ZIP-Datei gestartet. Automatische Updates gibt es nur, wenn du PKMessenger mit PKMessenger-Setup.exe installierst.';
  const enabled = !reason;
  state = { ...state, enabled, ...(reason ? { state: 'disabled', reason } : {}) };

  function start() {
    if (!enabled) return state;
    autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
    autoUpdater.on('update-available', () => set({ state: 'downloading', lastChecked: now() }));
    autoUpdater.on('update-not-available', () => set({ state: 'current', lastChecked: now() }));
    autoUpdater.on('update-downloaded', (_e, releaseNotes, releaseName) => set({ state: 'ready', newVersion: releaseName || null }));
    autoUpdater.on('error', (err) =>
      set({ state: 'error', lastChecked: now(), error: { message: 'Update-Prüfung fehlgeschlagen.', hint: 'Internetverbindung prüfen und später erneut versuchen.', detail: String(err?.message || err).slice(0, 200) } }),
    );
    if (argv.includes('--squirrel-firstrun')) later(check, FIRSTRUN_DELAY_MS);
    else check();
    schedule(check, CHECK_INTERVAL_MS);
    return state;
  }

  function check() {
    if (!enabled) return state;
    if (state.state === 'ready' || state.state === 'downloading' || state.state === 'checking') return state;
    try {
      autoUpdater.setFeedURL({ url: feedUrl(repo, platform, arch, version) }); // nach „Jetzt prüfen“ wieder der normale Dienst
      autoUpdater.checkForUpdates();
    } catch (err) {
      set({ state: 'error', error: { message: 'Update-Prüfung fehlgeschlagen.', hint: 'Später erneut versuchen.', detail: String(err?.message || err) } });
    }
    return state;
  }

  /**
   * „Jetzt prüfen“ (Wunsch JoniMoni, PR #26): GitHub SOFORT direkt fragen, ohne den Zwischenspeicher von update.electronjs.org.
   * Gibt es dort eine neuere Version, lädt Squirrel sie direkt vom GitHub-Release (RELEASES + .nupkg liegen dort).
   * Ist GitHub nicht erreichbar (offline, Abfrage-Limit), wird ganz normal über den Update-Dienst geprüft.
   */
  async function checkNow() {
    if (!enabled) return state;
    if (state.state === 'ready' || state.state === 'downloading' || state.state === 'checking') return state;
    set({ state: 'checking', error: null });
    let latest = null;
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'PKMessenger-Updater' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) latest = /^v?(\d+\.\d+\.\d+)$/.exec(String((await res.json())?.tag_name || ''))?.[1] || null;
    } catch {
      latest = null;
    }
    if (!latest) {
      set({ state: 'idle' });
      return check(); // Ersatzweg: normaler Update-Dienst
    }
    if (compareVersions(latest, version) <= 0) return set({ state: 'current', lastChecked: now(), latest });
    try {
      autoUpdater.setFeedURL({ url: directFeedUrl(repo, latest) });
      autoUpdater.checkForUpdates();
      return set({ latest });
    } catch (err) {
      return set({ state: 'error', error: { message: 'Update-Prüfung fehlgeschlagen.', hint: 'Später erneut versuchen.', detail: String(err?.message || err) } });
    }
  }

  /**
   * „Was ist neu?“ (Issue #1): letzte Releases mit Notizen und – falls es eine neuere Version gibt – die Änderungen
   * (Commits) seit der eigenen Version. Öffentliche GitHub-API, ohne Anmeldung (Limit 60 Abfragen/Std. pro IP).
   */
  async function changes() {
    if (!repo) throw Object.assign(new Error('Kein GitHub-Repo eingetragen.'), { code: 'VALIDATION', hint: '' });
    const get = async (url) => {
      let res;
      try {
        res = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'PKMessenger-Updater' }, signal: AbortSignal.timeout(10000) });
      } catch {
        throw Object.assign(new Error('GitHub ist gerade nicht erreichbar.'), { code: 'VALIDATION', hint: 'Internetverbindung prüfen und später erneut versuchen.' });
      }
      if (!res.ok) throw Object.assign(new Error(`GitHub antwortet nicht (${res.status}).`), { code: 'VALIDATION', hint: res.status === 403 ? 'Zu viele Abfragen – in einer Stunde nochmal versuchen.' : 'Später erneut versuchen.' });
      return res.json();
    };
    const gh = (u) => (typeof u === 'string' && u.startsWith('https://github.com/') ? u.slice(0, 500) : null);
    const list = await get(`https://api.github.com/repos/${repo}/releases?per_page=20`);
    const releases = (Array.isArray(list) ? list : [])
      .filter((r) => r && !r.draft && /^v\d+\.\d+\.\d+$/.test(String(r.tag_name)))
      .slice(0, 8) // #167: eigene android-v…-Releases fallen oben raus, angezeigt werden weiter 8
      .map((r) => ({
        tag: r.tag_name,
        name: String(r.name || r.tag_name).slice(0, 100),
        date: Date.parse(r.published_at) || null,
        notes: releaseNotes(r.body),
        url: gh(r.html_url),
        setupUrl: gh((r.assets || []).find((a) => a?.name === 'PKMessenger-Setup.exe')?.browser_download_url),
      }));
    const latest = releases[0]?.tag.slice(1) || null;
    let commits = [];
    if (latest && compareVersions(latest, version) > 0) {
      try {
        const cmp = await get(`https://api.github.com/repos/${repo}/compare/v${version}...v${latest}`);
        commits = commitList(cmp?.commits);
      } catch {
        commits = [];
      }
    }
    return { current: version, latest, newer: Boolean(latest && compareVersions(latest, version) > 0), releases, commits };
  }

  function install() {
    if (state.state !== 'ready') return false;
    autoUpdater.quitAndInstall();
    return true;
  }

  return { start, check, checkNow, changes, install, getState: () => state };
}

module.exports = { createUpdater, parseRepo, feedUrl, directFeedUrl, compareVersions, releaseNotes, commitList, CHECK_INTERVAL_MS, FIRSTRUN_DELAY_MS };
