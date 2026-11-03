# ADR-0008: Makefile on a Windows dev machine
Status: Accepted · 2026-10-26

> **Superseded by ADR-0019.** There is no Makefile or Docker any more; everything runs through npm scripts.

**Context.** The primary dev machine is Windows 11 and GNU make is not installed. The brief requires a Makefile.

**Decision.** Keep the Makefile as the single command surface (CI runs it on Linux). Targets only call
`docker compose ...` and POSIX sh, so they work from Git Bash once make is installed
(`choco install make`). No parallel PowerShell script to keep in sync. Repo uses `.gitattributes`
(`* text=auto eol=lf`) so shell scripts mounted into Linux containers keep LF endings.

**Consequences.** One prerequisite on Windows; identical commands in dev and CI.
