# Weekly Briefing

## 1. Review Info
- **Date:** Mon Oct 12 10:21:06 2026 +0200
- **Commit:** 591dd3cfbc332073bd5cae84b18b3734b69de823

## 2. Top findings
1. **UX/texts:** (src/help-web/app.js:201) The remote helper view allows helpers to see textboxes, but clicking them in the screen only sends a `click` event rather than prompting the helper to enter text for the `type` event.
   - *Why it is a problem:* Helpers cannot enter text into textboxes in remote support.
   - *How to fix:* Send `isText: true` from `src/renderer/helpBridge.js` inside `collectFields()`. In `src/help-web/app.js`, show a `prompt()` for text input if `f.isText` is true, and send `action: { type: 'type', text: ... }`.

2. **wrong behaviour:** (src/renderer/helpBridge.js:126) Settings modal fading check assumes the backdrop has an opacity less than 0.99. The check uses `Number(getComputedStyle(...).opacity) < 0.99`. This is usually fine, but relies on browser rendering details for timing. (Verified #164).
   - *Why it is a problem:* It's working currently, but could become brittle if React animations change.
   - *How to fix:* Instead of checking opacity, rely on a react class or unmount state if possible, though the current fix works and addresses the 700ms delay leak.

## 3. Open issues

- **#172** (`dependabot` tokens)
  - *Status:* open
  - *Missing:* The user mentions checking plugins to save API tokens for Dependabot. We need to check if there are `.github/workflows` actions taking tokens and consuming rate limits, but the issue states "suche im web , welche Plugins du verwenden kannst etc". The project rules say "Do not touch .github/workflows/, the "version" in package.json, .env files or secrets."
  - *Priority:* low

- **#170** (`supporter` accessibility)
  - *Status:* partly
  - *Missing:* Helpers cannot type in textboxes, no prompt appears. The issue also mentions that users cannot tick what the helper can see, and no password comes up. The password for remote support is already present (app password). The textbox typing issue needs fixing.
  - *Priority:* high

- **#169** (`Jules` strict instructions)
  - *Status:* done
  - *Missing:* This is an issue providing context for Jules's behavior (me).
  - *Priority:* low

- **#168** (`#164` chat leak, `#44` Maus/Tools)
  - *Status:* done
  - *Missing:* The chat leak was resolved by `__pkHelpFreshView` in `src/main/screenshots.js` and `src/renderer/helpBridge.js`.
  - *Priority:* low

- **#167** (`Bughunting`)
  - *Status:* open
  - *Missing:* Find bugs, better tests, extra release for apk. This is a general task.
  - *Priority:* medium

## 4. Suggested next steps
1. Deploy the fix for remote helper text input (prompts for typing into input fields).
2. Look into the `.apk` release pipeline for #167, ensure `mobile/` build uses the right certificates.
3. Review whether we need a UI toggle for users to select exactly what the helper can see (as mentioned in #170).
4. Monitor `#164` fix for performance (calling `capturePage()` twice might be heavy, but it drops the image if views don't match).
5. Double check rate limits/tokens in GitHub actions if permissible according to project rules, to address #172.