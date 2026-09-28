# IHatePDF v1.2.0

Adds **Share to phone**: send files or whole folders from the PC to a phone, fully offline, with nothing uploaded anywhere.

<img src="https://raw.githubusercontent.com/Burthcer/IHatePDF/main/docs/screenshots/share-setup.png" width="600" alt="Share to phone">

## Install

1. Download **IHatePDF-Setup.exe** below, under *Assets*.
2. Run it. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed.
3. Windows asks once for **administrator permission**. The installer uses it to add a Windows Firewall rule for IHatePDF, so phones can download from Share to phone without the app ever showing a network prompt.
4. If you installed an earlier version, uninstall it first (*Settings → Apps → IHatePDF*): this version installs for all users.

## New: Share to phone

It's the first tool on the home screen, and it's in the desktop app only.

1. Add files, folders, or both (buttons or drag and drop).
2. Pick how the phone connects:
   - **Same Wi-Fi:** the PC and phone are on the same network (internet not needed). Scan the QR code and download.
   - **PC hotspot (offline):** no Wi-Fi network at all. The PC's Wi-Fi card becomes a private hotspot; scan one QR code to join it and a second to download.
   - **Bluetooth (offline):** turn Bluetooth on on both devices and open the phone's Bluetooth settings so it can be found. Pick the phone from the list (none is chosen for you), then tap Accept on the phone.
3. The QR code stays active for 1, 5 or 10 minutes. It stops on **Stop sharing** or when you close the app, and the hotspot is turned off again if the app turned it on.

Folders download as a .zip. With several items the phone can download each one, or everything as one .zip.

| | Same Wi-Fi | PC hotspot | Bluetooth |
|---|---|---|---|
| Phones | Any | Any | Android only |
| Size limit | None | None | 4 GB, and slow |
| Needs | A network | A PC with Wi-Fi | Bluetooth on both devices |

## Also changed

- The phone's download page works on small screens, with long names and folder details wrapping properly.
- Share is the first section on the home screen.

Earlier changes: [v1.1.0 release notes](https://github.com/Burthcer/IHatePDF/releases/tag/v1.1.0).
