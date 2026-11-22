# Import from Proxmox and Docker Compose

Instances, Import moves workloads into Incus. It takes a Proxmox backup file or a Docker Compose file, shows what each part becomes and what doesn't carry over, and then runs the import in the background. You can close the browser; the import shows under Tasks when you come back.

Importing needs the manager role on the project you import into.

## Proxmox

Make a backup in Proxmox (Backup now, or `vzdump <id>`), copy the file from `/var/lib/vz/dump` and upload it. These work:

- VMs: `vzdump-qemu-*.vma`, plain or compressed with zstd or gzip.
- Containers: `vzdump-lxc-*.tar`, plain or compressed with zstd or gzip.

LZO files are refused. Make the backup again with zstd, which is the Proxmox default.

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

1. The UI reads the backup and builds an Incus image from it. A VM disk is converted to qcow2 on the fly; a container keeps its files and gets its user IDs shifted back if Proxmox stored them shifted.
2. Incus creates the instance from that image with its disks and network cards, and the image is deleted again.
3. If you chose to start it, the UI starts it and waits up to 3 minutes for a network address.

If any step fails, the UI deletes what it created and keeps the uploaded file so you can try again. Uploads nobody imports are deleted after a day.

### Things to know

- The import needs free space for the backup and the converted disk in the UI's data folder, plus the space on the Incus server.
- UEFI VMs boot the disk's default loader (`EFI/BOOT/BOOTX64.EFI`), because the boot entries in Proxmox's EFI disk are not imported. Most Linux and Windows installs have one.
- Legacy BIOS VMs need SeaBIOS on the Incus server. When it's missing and the disk has an EFI partition, the VM boots with UEFI instead and the task says so. Otherwise the import stops and tells you to install SeaBIOS.
- Windows VMs need the virtio drivers installed in Proxmox before the move if they used SATA or IDE disks.
- Network interface names can change in VMs. Keep the MAC address to keep DHCP reservations and interface names.

### How it's tested

Every change runs CI that makes backups with Proxmox's own `vma` tool and imports them into a real Incus: a BIOS VM, a UEFI VM with a data disk, a BIOS VM on an Incus without SeaBIOS, and a container. Each one has to boot and get an address.

## Docker Compose

Paste a `compose.yaml` or open the file, and add the contents of its `.env` file if it has one. Each service becomes an Incus application container that runs the same image from the same registry. Docker images need Incus 6.3 or newer.

An admin can put the stack in a new project named after it. Services then reach each other by service name, as they do in Docker. Others pick an existing project where they have the manager role.

### What carries over

| Compose | Incus |
| --- | --- |
| `image` | The same image, pulled from its registry |
| `environment` and `${VAR}` substitution | `environment.*` |
| `command`, `entrypoint`, `working_dir`, numeric `user` | `oci.cmd`, `oci.entrypoint`, `oci.cwd`, `oci.uid` (Incus 6.13 or newer) |
| `ports` | Proxy devices that listen on the Incus server |
| Named volumes | Custom volumes, named after the stack |
| `depends_on` | Start order and autostart priority |
| `restart` | `boot.autostart` |
| CPU and memory limits | `limits.cpu`, `limits.cpu.allowance`, `limits.memory` |

Services with only a `build` section are refused: build the image, push it to a registry and set `image`. Host folders (`./data:/data`) start empty, and so do named volumes: copy the data in with the file explorer. Health checks, capabilities, devices, extra networks and secrets don't carry over and show as warnings.

If an import fails, the UI deletes the containers, volumes and project it created.
