# Norfab Fleet — Roadside Evidence (auto-published)

This repo is **auto-managed** by the Norfab Fleet Watcher. **Do not edit files manually** — they get force-overwritten on every publish.

- Each publish does `git commit --amend` + force-push, so the repo always has exactly **one commit** (size stays bounded forever).
- Driver logs live at `/drivers/{token}/latest.pdf`. Tokens are deterministic hashes — same driver always gets the same URL.
- `robots.txt` + meta noindex block search engine indexing.
