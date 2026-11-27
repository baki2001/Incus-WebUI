# Backups

The UI backs up instances with Incus's own backup format and stores the files on a target you choose. A backup holds the whole instance (its config and root disk, without snapshots) and the custom volumes attached to it, and restores on any Incus server.

## Targets

Add targets under Settings, Backups. The Test button writes, reads and deletes a small file, so you know the target works before the first backup.

- **Directory**: an absolute path on the machine that runs the UI. A mounted NAS share works. When the UI runs as an Incus container, give it the folder with a disk device first, for example `incus config device add incus-webui backups disk source=/srv/backups path=/backups shift=true`, and use `/backups`.
- **S3**: any S3-compatible store, such as AWS, Backblaze B2, MinIO, Garage or Ceph. Fill in the endpoint, bucket, access key and secret key. The region can stay empty for stores that don't use one. The secret key is kept in `config.yaml` and never sent back to the browser.

Backups land under `<server>/<project>/<instance>/` on the target. Each backup is a `.tar` file with a `.json` file next to it that holds its size and SHA-256 checksum. Each attached custom volume gets its own file next to it, like `<backup>.vol0.tar`.

## Encryption

Turn on **Encrypt backups** on a target to encrypt everything the UI writes there. The UI encrypts while it streams, so it needs no temporary disk space. The files use [age](https://age-encryption.org) with a passphrase and end in `.tar.age`. The `.json` file next to each one stays readable, so the list still shows names and sizes.

The UI makes a long random passphrase for you. Copy it somewhere safe, like a password manager. Without it nobody can restore these backups, the UI included. To open a file by hand:

```sh
age -d -o backup.tar backup.tar.age
```

Changing the passphrase or turning encryption off only affects new backups. Older backups still need the passphrase they were made with, so keep it.

## Back up and restore

The Backups page in the sidebar lists the backups of every instance in the current server and project scope, on every target. Filter by instance, name or project, or by target. An instance's Backups tab lists only that instance's backups. Back up now makes one right away.

The Snapshots tab of an instance can also keep a snapshot on a backup target instead of on the server: pick the target in the list next to the name before you take it. The snapshot is a full backup that carries the name you gave it, and it shows on the Backups page and tab with that name. It doesn't expire and doesn't include memory; it stays until you delete it.

For each backup you can:

- **Restore** it as a new instance, in the same project or another one, and on another storage pool if you like. An instance that still exists is not touched; when the original is gone, the restore offers its old name. The UI checks the checksum on the way, and a damaged file is refused without leaving a half-made instance behind.
- **Download** it. `incus import` reads the file on any Incus server. A backup with volumes lets you pick the instance or one of its volumes; `incus storage volume import` reads a volume file. Encrypted backups download already decrypted.
- **Delete** it.

A restore brings the custom volumes back first. A volume keeps its old name when that's free, and otherwise gets `<instance>-<volume>`. The restored instance points at the restored volumes, never at the originals.

These need the manager role on the instance's project, because a backup holds all of the instance's data.

## Schedules

A schedule backs up a project, or a list of its instances, once a day at the time you set. It keeps the newest backup of each of the last days and weeks you choose (7 and 4 by default) and deletes older ones. It never deletes backups made by hand, and always keeps the newest one.

Turn on **Test restore on Sundays** to restore each Sunday backup under a temporary name and delete it again. A backup that can't be restored then shows up as a failed run, instead of when you need it.

Each schedule shows when it last ran and why it failed, if it did. Run now starts it right away. A run that was missed because the UI was down starts as soon as the UI is back.

Schedules run in the UI, so the UI has to be running at that time. Times are in the time zone of the machine that runs the UI.
