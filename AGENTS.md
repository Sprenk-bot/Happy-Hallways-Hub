# Happy Hallways Hub project instructions

## Product authority

- Before Hub-related work, read `docs/Happy_Hallways_Hub_Edition_Master_Specification.md` and the existing UI reference pack. The specification is the authoritative requirements source. If either is missing, check for the user-supplied copy beside the repository; if still unavailable, ask before making assumptions.
- Preserve existing Happy Hallways behaviour, screens, navigation, visual identity and reusable components wherever possible. Extend existing features before replacing them. Keep ordinary classroom passes separate from Hub visits and movement events.
- Update the master specification only when the user explicitly approves a requirements change.

## Approved direction and fallbacks

- The Hub Host is the authoritative local service and durable data store. Its process must remain available independently of the kiosk browser. Use the user/ICT-approved host device and operating system; if unavailable or unsuitable, present the documented alternatives for approval rather than choosing silently.
- Prefer school-approved staff SSO with its MFA. If unavailable, offer the TIC-approved named-profile and revocable device-enrolment fallback. Do not describe name entry or device pairing as MFA. Do not use real student data until ICT approves an MFA-capable sign-in or compensating control.
- Prefer authenticated, encrypted school-LAN connections so local operations can continue without internet. Test the actual network. PeerJS/WebRTC may be an alternative only when approved and its internet/service dependencies are clear. Show disconnected or pending states accurately; never report an action as saved until the Host acknowledges it.
- Provide automatic local recovery snapshots (15-minute initial target), an ICT-approved school-controlled off-host copy (five-minute lag target), integrity checks, isolated restore tests and staged recovery. Show actual health and lag. If the preferred destination is unavailable, queue replication and show degraded protection; offer only ICT-approved alternatives. Do not auto-delete records or backups before the school records authority approves a retention rule.
- Do not add paid services, subscriptions, external student-data services, analytics carrying student data or external AI providers without explicit approval.

## Development and data safety

- Work in small, reviewable stages. Before each stage, inspect the relevant source, types, data flow and tests, then tell the user the proposed behaviour, affected files, migration/data risks and acceptance checks. Implement only the approved stage.
- Preserve student identity and PIN continuity, visit history, original timestamps, staff attribution and audit records. Use versioned, recoverable migrations and back up before high-impact changes.
- Use fictional student and staff information only. Never include real student data in prompts, fixtures, screenshots or logs.
- Never perform destructive migrations, delete or overwrite existing data, replace the original repository, deploy or publish without explicit approval. Keep a recoverable baseline and use a separate private working copy for Hub development.
- Run relevant checks, tests and builds after changes. Do not claim a check passed unless it was run.
- At each handoff, report changed files, behaviour, checks and results, limitations, risks and outstanding issues. Do not imply ICT approval, authentication, LAN operation or recovery is verified until tested on the intended setup.

## Repository conventions

- Continue with the existing SvelteKit, Svelte, TypeScript and Bun setup unless an approved technical decision justifies a change. Prefer simple, maintainable code and avoid dependencies for small features that fit the existing stack.
- Do not push or publish this private project unless the user explicitly approves it and the destination and automation have been checked.
