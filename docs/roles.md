# Roles and the audit log

## Roles

Admins give people a role per server and project under Settings, Users and roles. Each entry says who, where and which role:

- **Who**: `user:name` for a local user, `sso:name` for a single sign-on user, `group:name` for an SSO group, or `*` for everyone who can sign in.
- **Where**: a server and a project, or `*` for all of them.
- **Role**, each one including the ones before it:
  - **Viewer** sees instances, their state and history.
  - **Operator** starts, stops and restarts instances, makes snapshots, uses the terminal, console and files, and follows running operations.
  - **Manager** creates, changes and deletes instances, volumes and other resources in the project, and makes, restores and downloads backups.
  - **Admin** manages servers, users, roles, backup targets, tunnels, updates and anything that affects the whole server. Admin is always for all servers and projects.

Changes to things every project shares need the admin role: networks, and the profiles, volumes and images of a project that uses the default project's ones. Copying an instance or volume from another project needs the manager role there too.

> [!IMPORTANT]
> Incus trusts the UI fully, so a manager can make a privileged container or mount a host folder, which gives root on the host. To keep managers inside their project, set `restricted` to `true` on the project under Projects. Incus then refuses those settings for everyone working in it.

Someone with several entries gets the highest role that fits. People see only the projects where they have a role; lists that span all projects are filtered. The UI checks every Incus call it forwards, so hiding a button is never the only protection.

Installs from before 0.5 start with one entry that makes everyone admin, which is how they worked. New installs make the first user admin. You can't save a list that takes away your own admin role.

## Audit log

Activity, Audit log shows who changed what: every change made through the UI, every sign-in and failed sign-in, and every scheduled backup. Admins can filter it by user, action or address, one month at a time. The log is kept per month in the `audit` folder of the data directory for 12 months.

## History

The UI reads each server's metrics every minute and keeps a day of minute points and a week of ten-minute points for every instance. The History tab of an instance and the host page show CPU, memory, network and disk. History starts when the UI starts and survives restarts. People see the history of the projects where they have a role.
