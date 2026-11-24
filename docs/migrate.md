# Import from Proxmox and Docker Compose

Instances, Import moves workloads into Incus. It takes a Proxmox backup file or a Docker Compose file, shows what each part becomes and what doesn't carry over, and then runs the import in the background. You can close the browser; the import shows under Tasks when you come back.

Importing needs the manager role on the project you import into.

## Proxmox

Make a backup in Proxmox (Backup now, or `vzdump <id>`), copy the file from `/var/lib/vz/dump` and upload it. These work:

- VMs: `vzdump-qemu-*.vma`, plain or compressed with zstd or gzip.
- Containers: `vzdump-lxc-*.tar`, plain or compressed with zstd or gzip.

LZO files are refused. Make the backup again with zstd, which is the Proxmox default.

### From a Proxmox Backup Server

The UI can also import straight from a Proxmox Backup Server (PBS). It downloads the backup itself, so nothing goes through your browser.

1. In PBS, go to Configuration, Access Control, API Token and add a token, for example `root@pam!incus`.
2. Under Permissions, give that token the `DatastoreReader` role on `/datastore/<name>`. With Privilege Separation on (the default) the role must be on the token, not only on its user.
3. In the UI, an admin adds the server under Settings, Backups, Proxmox Backup Servers: the address (`https://pbs.lan:8007`), the datastore, the token ID and its secret. PBS uses a self-signed certificate, so also paste the fingerprint from the PBS dashboard (Show Fingerprint). Click Test.
4. In the import sheet, pick Proxmox Backup Server and then the backup.

Only admins can import from PBS. A datastore holds the backups of every guest, and nothing ties a backup to an Incus project, so a project manager could otherwise pull in someone else's VM.

VM and container backups made by Proxmox VE work, in both archive formats PBS uses for containers. Encrypted backups don't: PBS can't decrypt them for the UI. Restore those in Proxmox and make a vzdump backup instead.

### What carries over

| Proxmox | Incus |
| --- | --- |
| Cores and sockets, memory | `limits.cpu`, `limits.memory` |
| Boot disk | Root disk of the same size |
| Other disks (VMs) | Custom block volumes, attached to the VM |
| Network cards | NICs on the network you pick, with the same MAC address if you keep it |
| SeaBIOS or OVMF, Secure Boot keys | `security.csm` or UEFI, `security.secureboot` |
| TPM | A new, empty TPM |
| Start at boot | `boot.autostart` |
| Privileged container | An unprivileged container |

The preview lists everything else as a warning, such as PCI or USB passthrough, extra QEMU arguments and container mount points that were not in the backup.

### What happens during the import

The import has two parts:

- **Upload** (not for PBS). Your browser sends the backup to the UI server. This is the only part that needs the browser, so keep the page open until the upload reaches 100%. The file then waits in the UI's data folder until you import or remove it, for a day at most. The import sheet shows when each upload goes and how much space they take.
- **Import.** This runs on the UI server. Once you click Import you can close the browser; the import keeps going and shows under Tasks.

The import itself:

1. The UI reads the backup and builds an Incus image from it. A VM disk is converted to qcow2 on the fly; a container keeps its files and gets its user IDs shifted back if Proxmox stored them shifted.
2. Incus creates the instance from that image with its disks and network cards, and the image is deleted again.
3. If you chose to start it, the UI starts it and waits up to 3 minutes for a network address.

If any step fails, the UI deletes what it created and keeps the uploaded file so you can try again. A successful import deletes the uploaded file.

### Things to know

- The import needs free space for the backup and the converted disk in the UI's data folder, plus the space on the Incus server.
- Once the image is sent, Incus still checks and stores it before the instance exists. For a big disk this takes a few minutes; the task counts the time so you can see it's still busy.
- A UI restart stops a running import. The UI then deletes its half-finished files; the uploaded backup stays so you can start again.
- Unpacking and converting a backup keeps about one CPU core busy on the UI server for the length of the import. It runs at a lower priority, so the rest of the UI stays responsive. To cap it, set `limits.cpu` on the UI's instance.
- UEFI VMs boot the disk's default loader (`EFI/BOOT/BOOTX64.EFI`), because the boot entries in Proxmox's EFI disk are not imported. Most Linux and Windows installs have one.
- Legacy BIOS VMs need SeaBIOS on the Incus server. When it's missing and the disk has an EFI partition, the VM boots with UEFI instead and the task says so. Otherwise the import stops and tells you to install SeaBIOS.
- If the last partition of the boot disk runs to the very end of the disk, the disk gets up to 1 MiB bigger. Incus moves the backup partition table to the end of every new VM disk and refuses a disk where a partition is in the way. The task says when this happened.
- Windows VMs need the virtio drivers installed in Proxmox before the move if they used SATA or IDE disks.
- Network interface names can change in VMs. Keep the MAC address to keep DHCP reservations and interface names.

### How it's tested

Every change runs CI that makes backups with Proxmox's own `vma` tool and imports them into a real Incus: a BIOS VM, a UEFI VM with a data disk, a BIOS VM on an Incus without SeaBIOS, a 12 GiB VM whose last partition fills the disk, and a container. A second job runs a real Proxmox Backup Server, backs up two VMs and two containers (one in each archive format) with `proxmox-backup-client`, and imports them. Each one has to boot and get an address.

## Docker Compose

Paste a `compose.yaml` or open the file, and add the contents of its `.env` file if it has one. Each service becomes an Incus application container that runs the same image from the same registry. Docker images need Incus 6.3 or newer.

An admin can put the stack in a new project named after it. Services then reach each other by service name, as they do in Docker. Others pick an existing project where they have the manager role.

### What carries over

| Compose | Incus |
| --- | --- |
| `image` | The same image, pulled from its registry |
| `environment` and `${VAR}` substitution | `environment.*` |
| `command`, `entrypoint`, `working_dir`, numeric `user` | `oci.entrypoint`, `oci.cwd`, `oci.uid` (Incus 6.13 or newer). A `command` alone runs after the image's own entrypoint, which the UI reads from the registry. |
| `ports` | Proxy devices that listen on the Incus server |
| Named volumes | Custom volumes, named after the stack |
| `depends_on` | Start order and autostart priority |
| `restart` | `boot.autostart` |
| CPU and memory limits | `limits.cpu`, `limits.cpu.allowance`, `limits.memory` |

Services with only a `build` section are refused: build the image, push it to a registry and set `image`. Host folders (`./data:/data`) start empty, and so do named volumes: copy the data in with the file explorer. Health checks, capabilities, devices, extra networks and secrets don't carry over and show as warnings.

If an import fails, the UI deletes the containers, volumes and project it created.
