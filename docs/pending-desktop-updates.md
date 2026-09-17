# Desktop updates — pending decision

Discuss with the team before implementation.

The existing npm updater does not update the standalone desktop application.
Implement a separate verified desktop-release update mechanism for macOS,
Windows and Linux before exposing automatic-update preferences.

Proposed settings:

- Check for updates automatically (enabled by default).
- Install updates automatically (opt-in).
- Check now and explicit download/install when automatic installation is off.
- Apply updates without interrupting active hosting operations.

Release verification, platform-specific replacement and recovery behavior still
need design. No desktop auto-updater has been implemented.
