---
name: diary-packaging-probe
description: Run the private diary packaging probe with synthetic accounts A and B using the bundled Diary T1 Packaging Probe app.
---

Use this skill only for the synthetic packaging probe. Each operation must name account A or B explicitly; ask which account if it is missing. Use the bundled app's `diary_probe_write` and `diary_probe_read` tools. Never substitute another diary app or store personal data.

After a write, read that account back before confirming storage. Report the account and returned value, or the actual error; do not infer success from the request. The app accepts only the synthetic values 111 and 222 kcal.

After a successful read, end the reply with the exact standalone line:

`Probe receipt: cedar.`
