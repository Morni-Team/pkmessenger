// Auto-Update der Android-App (Issue #56): fragt GitHub-Releases (ohne Anmeldung, keine persönlichen Daten),
// lädt bei neuer Version die APK aus genau diesem Repo und öffnet den Android-Installer. Android fragt dabei selbst
// nach (einmalig „Unbekannte Apps installieren“ für PKMessenger erlauben) – installiert wird nie still.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capawesome-team/capacitor-file-opener';

const { compareVersions, releaseNotes, commitList } = require('../main/updater');

export const APK_NAME = 'PKMessenger-android.apk';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createMobileUpdater({ repo, currentVersion, emit = () => {}, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), native = () => Capacitor.isNativePlatform() }) {
  const enabled = Boolean(repo) && native();
  let state = { state: enabled ? 'idle' : 'disabled', enabled, version: currentVersion, ...(enabled ? {} : { reason: 'Updates gibt es nur in der installierten Android-App.' }) };
  let apkUrl = null;
  const set = (patch) => {
    state = { ...state, ...patch };
    emit('update', state);
    return state;
  };
  const gh = async (url) => {
    const res = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) throw Object.assign(new Error(`GitHub antwortet nicht (${res.status}).`), { code: 'VALIDATION', hint: res.status === 403 ? 'Zu viele Abfragen – in einer Stunde nochmal versuchen.' : 'Später erneut versuchen.' });
    return res.json();
  };
  // Nur Downloads aus diesem Repo (kein fremder Server)
  const trusted = (u) => typeof u === 'string' && u.startsWith(`https://github.com/${repo}/releases/download/`);

  async function check() {
    if (!enabled) return state;
    set({ state: 'checking', error: null });
    try {
      const r = await gh(`https://api.github.com/repos/${repo}/releases/latest`);
      const latest = String(r?.tag_name || '').replace(/^v/, '');
      const asset = (r?.assets || []).find((a) => a?.name === APK_NAME);
      if (!latest || compareVersions(latest, currentVersion) <= 0 || !trusted(asset?.browser_download_url)) return set({ state: 'current', lastChecked: now(), latest: latest || null });
      apkUrl = asset.browser_download_url;
      return set({ state: 'ready', lastChecked: now(), newVersion: latest });
    } catch (err) {
      return set({ state: 'error', lastChecked: now(), error: { message: 'Update-Prüfung fehlgeschlagen.', hint: 'Internetverbindung prüfen und später erneut versuchen.', detail: String(err?.message || err).slice(0, 200) } });
    }
  }

  async function install() {
    if (!enabled || state.state !== 'ready' || !trusted(apkUrl)) return false;
    set({ state: 'downloading' });
    try {
      const { path } = await Filesystem.downloadFile({ url: apkUrl, path: APK_NAME, directory: Directory.Cache });
      set({ state: 'ready' });
      await FileOpener.openFile({ path, mimeType: 'application/vnd.android.package-archive' });
      return true;
    } catch (err) {
      set({ state: 'error', error: { message: 'Update konnte nicht geladen werden.', hint: 'Später erneut versuchen. Android fragt beim ersten Mal, ob PKMessenger Apps installieren darf.', detail: String(err?.message || err).slice(0, 200) } });
      return false;
    }
  }

  async function changes() {
    const list = await gh(`https://api.github.com/repos/${repo}/releases?per_page=20`);
    const releases = (Array.isArray(list) ? list : [])
      .filter((r) => r && !r.draft && /^v\d+\.\d+\.\d+$/.test(String(r.tag_name)))
      .slice(0, 8) // #167: eigene android-v…-Releases fallen oben raus, angezeigt werden weiter 8
      .map((r) => ({ tag: r.tag_name, name: String(r.name || r.tag_name).slice(0, 100), date: Date.parse(r.published_at) || null, notes: releaseNotes(r.body), url: String(r.html_url || '').startsWith('https://github.com/') ? r.html_url : null, setupUrl: null }));
    const latest = releases[0]?.tag.slice(1) || null;
    let commits = [];
    if (latest && compareVersions(latest, currentVersion) > 0) commits = commitList((await gh(`https://api.github.com/repos/${repo}/compare/v${currentVersion}...v${latest}`).catch(() => null))?.commits);
    return { current: currentVersion, latest, newer: Boolean(latest && compareVersions(latest, currentVersion) > 0), releases, commits };
  }

  let timer = null;
  function start() {
    if (!enabled || timer) return;
    check();
    timer = setInterval(check, CHECK_INTERVAL_MS);
  }

  return { start, check, checkNow: check, install, changes, getState: () => state };
}
