# Instances on your own LAN

By default Incus puts instances on `incusbr0`, a private network with its own subnet, DHCP and NAT. To give an instance an address on your home or office network instead, for example 192.168.1.50 next to your router, connect its network card to the host's own interface.

## Pick the LAN

On an instance's Configuration tab, open the network picker of a card. The group **Your LAN, through the host** lists the host's interfaces:

- **A host bridge** (such as `br0`) is the best choice. The instance sits on the LAN, and the host and the instance can reach each other.
- **A plain interface** (such as `eth0` or `enp3s0`) works through macvlan. No host setup is needed, but the host itself can't reach the instance over it. Other machines on the LAN can.

The Create sheet has the same choices under Network. Host interfaces also show on the Networks page, read-only, since the host manages them rather than Incus.

## Automatic or fixed address

With **Automatic (DHCP)**, your router hands out the address. To keep it the same, reserve the card's MAC address in your router. The Configuration tab shows it after the first start.

With **Fixed address**, you enter the address with its prefix (`192.168.1.50/24`), the gateway and DNS servers. The UI writes them into the instance, the way Proxmox does:

- Containers get a network file of their own: `/etc/netplan/90-incus-webui-eth0.yaml` (Ubuntu), the `eth0` stanza in `/etc/network/interfaces` (Debian, Alpine, containers imported from Proxmox), or `/etc/systemd/network/10-incus-webui-eth0.network`. Restart the container to use it.
- VMs get it through `cloud-init.network-config`, so the VM needs cloud-init. Cloud images have it.

The address is kept in the instance config as `user.incus-webui.ip.eth0`. Pick one your router doesn't hand out. Switching back to Automatic removes the file, or sets the stanza back to DHCP.

On an Incus bridge such as `incusbr0`, a fixed address is handled by Incus itself (`ipv4.address` on the card), so nothing is written into the instance. It has to sit inside that bridge's subnet.

## Making a host bridge

A host bridge is set up on the host, not in Incus. On Debian with ifupdown, replace the `eth0` lines in `/etc/network/interfaces` with:

```
auto br0
iface br0 inet static
    address 192.168.1.19/24
    gateway 192.168.1.1
    bridge_ports eth0
    bridge_stp off
```

Install `bridge-utils`, then run `systemctl restart networking`, or reboot. Do this from a console rather than over SSH, since the host's address moves from `eth0` to `br0`. On Ubuntu, netplan does the same with a `bridges:` section. IncusOS sets up its own bridges.
