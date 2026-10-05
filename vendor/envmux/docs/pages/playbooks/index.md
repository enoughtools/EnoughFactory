# Playbooks

Numbered procedures, for doing a thing rather than understanding it. Each one
says when to use it, what you need first, the exact commands and what you should
see, how to verify, how to roll back, and what each failure means. The reasons
are on [Host](../host.md) and [Browser](../browser.md); they are not repeated
here.

| Playbook | Use it when |
|---|---|
| [Add a remote Incus host](add-remote-host.md) | You run Incus on another machine and want this workstation's sessions there. Two steps: prepare the host, install with the token. Ends with what is true today about more than one host |
| [Swap a workstation from its Hyper-V host to a remote Incus](swap-host.md) | Same `~/.envmux`, same zone, new host — with the old VM stopped, not deleted, and a two-command rollback |
| [Prove a host works](prove-host.md) | After either of the above, or after anything changed underneath. A scratch project, every promise exercised once, cleaned up after |

The values in them are from a real run: a workstation at `192.168.19.21`, an
Incus host at `192.168.19.43:8443` running Incus 7.0.1 on Ubuntu 26.04 with
Docker beside it, the range `10.100.0.1/24`, the zone `envmux`. Substitute your
own; a token is always `<token>`.
