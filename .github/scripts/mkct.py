# Builds a container backup shaped like a Proxmox vzdump archive from a
# rootfs tarball, for the migration tests. Usage: mkct.py SRC.tar.xz OUT.tar SHIFT
import tarfile, io, sys
src = tarfile.open(sys.argv[1], 'r:xz')
out = tarfile.open(sys.argv[2], 'w', format=tarfile.PAX_FORMAT)
shift = int(sys.argv[3])
conf = b"""arch: amd64
cores: 2
features: nesting=1
hostname: web-01
memory: 1024
net0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth
onboot: 1
ostype: ubuntu
rootfs: local-lvm:vm-105-disk-0,size=8G
swap: 512
unprivileged: 1
"""
root = tarfile.TarInfo('./'); root.type = tarfile.DIRTYPE; root.mode = 0o755; root.uid = root.gid = shift
out.addfile(root)


vz = tarfile.TarInfo('./etc/vzdump/pct.conf'); vz.size = len(conf); vz.uid = vz.gid = shift
out.addfile(vz, io.BytesIO(conf))
net = b"[Match]\nName = eth0\n\n[Network]\nDescription = Interface eth0 autoconfigured by PVE\nDHCP = v4\n"
ni = tarfile.TarInfo('./etc/systemd/network/eth0.network'); ni.size = len(net); ni.uid = ni.gid = shift; ni.mode=0o644
out.addfile(ni, io.BytesIO(net))
for m in src:
    n = m.name
    if n in ('.', './'): continue
    if not n.startswith('./'): n = './' + n
    m.name = n
    if m.islnk() and not m.linkname.startswith('./'): m.linkname = './' + m.linkname.lstrip('/')
    m.uid += shift; m.gid += shift; m.uname = m.gname = ''
    out.addfile(m, src.extractfile(m) if m.isreg() else None)
out.close()
