# Weekly Briefing

## 1. Review Info
- **Date:** Mon Oct 26 10:22:44 2026 +0100
- **Commit:** 35d7a2e284f4119010ed7ff67eab1804e60f3b83

## 2. Top findings
1. **Security:** (`package.json`) `electron` dependency has known vulnerabilities (e.g. GHSA-jr5w-w6x2-84p9) on version `44.9.0`.
   - *Why it is a problem:* It leaves the application vulnerable to compromised eMudhra intermediate certificates.
   - *How to fix:* Update `electron` to `45.0.0` in `package.json` and run `npm install` to update `package-lock.json`.

2. **wrong behaviour:** (src/renderer/helpBridge.js:126) Settings modal fading check assumes the backdrop has an opacity less than 0.99. The check uses `Number(getComputedStyle(...).opacity) < 0.99`. This is usually fine, but relies on browser rendering details for timing. (Verified #164).
   - *Why it is a problem:* It's working currently, but could become brittle if React animations change.
   - *How to fix:* Instead of checking opacity, rely on a react class or unmount state if possible, though the current fix works and addresses the 700ms delay leak.

## 3. Open issues

- **#179** (`Sicherheitslücke beheben: electron`)
  - *Status:* done
  - *Missing:* Nothing. The fix is included in this PR.
  - *Priority:* high

## 4. Suggested next steps
1. Review if other dependencies need auditing (e.g. `undici` which also showed up in audit).
2. Monitor any regressions with the Electron 45 upgrade.
3. Look into the `.apk` release pipeline for mobile app.
4. Review whether we need a UI toggle for users to select exactly what the helper can see in remote support.
5. Improve tests for network disconnect edge cases.