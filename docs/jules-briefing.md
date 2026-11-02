# Weekly Briefing

## 1. Review Info
- **Date:** Mon Nov 02 2026 18:55:11 GMT+0000 (Coordinated Universal Time)
- **Commit:** d3272eab91764a26e15da99be399445fb2394b55

## 2. Top findings
1. **wrong behaviour:** (`src/renderer/helpBridge.js:141`) Settings modal fading check assumes the backdrop has an opacity less than 0.99. The check uses `Number(getComputedStyle(...).opacity) < 0.99`. This is usually fine, but relies on browser rendering details for timing. (Verified #164).
   - *Why it is a problem:* It's working currently, but could become brittle if React animations change.
   - *How to fix:* Instead of checking opacity, rely on `getAnimations().length > 0` which more accurately checks if an animation is currently running.

## 3. Open issues

- **#179** (`Sicherheitslücke beheben: electron`)
  - *Status:* done
  - *Missing:* Nothing.
  - *Priority:* high

- **#164** (`settings opacity leak delay`)
  - *Status:* done
  - *Missing:* Nothing. The fix is included in this PR.
  - *Priority:* medium

- **#152** (`Pages-Seite: Direktverbindung steckt in app.js`)
  - *Status:* done
  - *Missing:* Nothing.
  - *Priority:* low

- **#110** (`Krypto-Miner/Cryptojacking-Dienste`)
  - *Status:* done
  - *Missing:* Nothing.
  - *Priority:* low

## 4. Suggested next steps
1. Review if other dependencies need auditing (e.g. `undici` which also showed up in audit).
2. Monitor any regressions with the Electron 45 upgrade.
3. Look into the `.apk` release pipeline for mobile app.
4. Review whether we need a UI toggle for users to select exactly what the helper can see in remote support.
5. Improve tests for network disconnect edge cases.
