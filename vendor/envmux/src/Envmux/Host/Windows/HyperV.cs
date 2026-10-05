using System.Globalization;
using System.Net;
using System.Text.Json;

using Envmux.Process;

namespace Envmux.Host.Windows;

/// <summary>
/// One attached disk, identified by where it is plugged in.
/// </summary>
/// <remarks>
/// The location is the identity, not the path. Hyper-V's automatic checkpoints
/// silently replace a disk's file with a differencing <c>.avhdx</c> whose name
/// carries a fresh GUID, so anything that recognised the media by its filename
/// stops recognising it — and, worse, starts recognising the system disk
/// instead. The controller and slot are decided when the VM is created and never
/// move.
/// </remarks>
/// <param name="Controller">"SCSI" or "IDE".</param>
/// <param name="Number">Which controller.</param>
/// <param name="Location">Which slot on it.</param>
/// <param name="Path">Whatever file is behind it right now.</param>
internal sealed record VmDisk(string Controller, int Number, int Location, string Path)
{
    /// <summary>Where the VM's own disk goes: the first slot, created with the VM.</summary>
    public const int SystemSlot = 0;

    /// <summary>And where the install media is attached, until it is taken away.</summary>
    public const int MediaSlot = 1;

    public override string ToString() => $"{Controller}/{Number}/{Location}  {Path}";
}

/// <summary>What a VM is doing, as Hyper-V reports it.</summary>
/// <param name="Exists">Whether there is a VM by that name at all.</param>
/// <param name="State">"Running", "Off", and the rest.</param>
/// <param name="Disks">Every attached disk, in controller order.</param>
/// <param name="Checkpoints">How many checkpoints it has, which should be none.</param>
internal sealed record VmStatus(
    bool Exists,
    string State,
    IReadOnlyList<VmDisk> Disks,
    int Checkpoints = 0)
{
    public bool IsRunning => State.Equals("Running", StringComparison.OrdinalIgnoreCase);

    /// <summary>The disk the VM installed itself onto.</summary>
    public VmDisk? System => Disks.FirstOrDefault(d => d.Location == VmDisk.SystemSlot);

    /// <summary>The install media, while it is still attached.</summary>
    public VmDisk? Media => Disks.FirstOrDefault(d => d.Location == VmDisk.MediaSlot);
}

/// <summary>
/// The Hyper-V half: a Generation 2 VM with Secure Boot off and a real vTPM.
/// </summary>
/// <remarks>
/// <para>
/// That combination is not a preference. Hyper-V's UEFI cannot enrol IncusOS'
/// custom Secure Boot keys, so Secure Boot must be off — and IncusOS refuses to
/// run with Secure Boot off and a software-backed TPM, so the TPM has to be the
/// real Hyper-V vTPM. There is no third configuration, and there is no fallback
/// if <c>Enable-VMTPM</c> is unavailable.
/// </para>
/// <para>
/// A vTPM needs a key protector first, and the local one is what makes the VM
/// bound to this machine. That is the correct trade for a development host: the
/// VM is reproducible from the seed, so a machine that cannot decrypt it is a
/// rebuild rather than a loss.
/// </para>
/// </remarks>
internal static class HyperV
{
    /// <summary>The system disk floor the IncusOS installer enforces.</summary>
    public const long MinimumSystemDisk = 50L * 1024 * 1024 * 1024;

    public const long DefaultSystemDisk = 256L * 1024 * 1024 * 1024;
    public const long DefaultMemory = 16L * 1024 * 1024 * 1024;
    public const int DefaultProcessors = 8;

    /// <summary>Whether the Hyper-V module is installed and usable from here.</summary>
    public static async Task<bool> IsAvailableAsync(CancellationToken ct = default) =>
        Powershell.IsAvailable && await Powershell.HasCommandAsync("New-VM", ct).ConfigureAwait(false);

    /// <summary>
    /// Turn a fixed VHD into the VHDX a Generation 2 VM boots from.
    /// </summary>
    /// <remarks>
    /// qemu-img when it is there, because it goes straight from the raw image to
    /// a dynamic VHDX. Otherwise <c>Convert-VHD</c>, which is part of the
    /// Hyper-V role that has to be installed anyway — so the fallback needs
    /// nothing the target machine does not already have.
    /// </remarks>
    public static async Task<string> ConvertAsync(
        string rawImage,
        string vhdxPath,
        Guid id,
        DateTimeOffset now,
        Action<string>? report = null,
        CancellationToken ct = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(vhdxPath))!);

        if (File.Exists(vhdxPath))
        {
            File.Delete(vhdxPath);
        }

        if (await ProcessRunner.ExistsAsync("qemu-img").ConfigureAwait(false))
        {
            report?.Invoke("converting with qemu-img");

            await ProcessRunner.CheckedAsync(
                "qemu-img",
                ["convert", rawImage, "-O", "vhdx", "-o", "subformat=dynamic", vhdxPath],
                ct: ct).ConfigureAwait(false);

            return vhdxPath;
        }

        // Convert-VHD talks to the storage virtualisation service, which will
        // not answer an unelevated caller. Said before several gigabytes are
        // copied rather than after.
        await RequireElevationAsync(
            "Convert-VHD",
            "run this from an Administrator terminal, or install qemu-img — which does the same " +
            "conversion, from the raw image, without needing one",
            ct).ConfigureAwait(false);

        var vhd = Path.ChangeExtension(vhdxPath, ".vhd");
        report?.Invoke("wrapping the raw image as a fixed VHD");
        await VhdFooter.WriteAsync(rawImage, vhd, id, now, ct).ConfigureAwait(false);

        try
        {
            report?.Invoke("converting with Convert-VHD");

            await Powershell.CheckedAsync(
                "Convert-VHD -Path $Source -DestinationPath $Destination -VHDType Dynamic | Out-Null",
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["Source"] = Path.GetFullPath(vhd),
                    ["Destination"] = Path.GetFullPath(vhdxPath),
                },
                ct).ConfigureAwait(false);
        }
        finally
        {
            // The intermediate is the raw image again plus 512 bytes, which for
            // install media is several gigabytes of nothing anybody wants.
            File.Delete(vhd);
        }

        return vhdxPath;
    }

    /// <summary>What Hyper-V thinks of a VM by that name.</summary>
    public static async Task<VmStatus> StatusAsync(string name, CancellationToken ct = default)
    {
        var json = await Powershell.JsonAsync(
            """
            $vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
            if (-not $vm) { '{"exists":false,"state":"","disks":[],"checkpoints":0}'; exit 0 }

            [pscustomobject]@{
              exists      = $true
              state       = [string]$vm.State
              checkpoints = @(Get-VMCheckpoint -VMName $Name -ErrorAction SilentlyContinue).Count
              disks       = @(Get-VMHardDiskDrive -VMName $Name | ForEach-Object {
                              [pscustomobject]@{
                                controller = [string]$_.ControllerType
                                number     = [int]$_.ControllerNumber
                                location   = [int]$_.ControllerLocation
                                path       = [string]$_.Path
                              }
                            })
            } | ConvertTo-Json -Compress -Depth 4
            """,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Name"] = name },
            ct).ConfigureAwait(false);

        if (json.ValueKind != JsonValueKind.Object ||
            !json.TryGetProperty("exists", out var exists) ||
            exists.ValueKind != JsonValueKind.True)
        {
            return new VmStatus(false, "", []);
        }

        var disks = new List<VmDisk>();

        if (json.TryGetProperty("disks", out var list))
        {
            // One disk comes back as a bare object rather than an array, because
            // ConvertTo-Json unrolls a pipeline of one.
            var each = list.ValueKind == JsonValueKind.Array
                ? list.EnumerateArray().ToArray()
                : [list];

            foreach (var disk in each)
            {
                if (disk.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                disks.Add(new VmDisk(
                    disk.TryGetProperty("controller", out var c) ? c.GetString() ?? "" : "",
                    disk.TryGetProperty("number", out var n) ? n.GetInt32() : 0,
                    disk.TryGetProperty("location", out var l) ? l.GetInt32() : 0,
                    disk.TryGetProperty("path", out var p) ? p.GetString() ?? "" : ""));
            }
        }

        return new VmStatus(
            true,
            json.TryGetProperty("state", out var state) ? state.GetString() ?? "" : "",
            disks,
            json.TryGetProperty("checkpoints", out var cps) && cps.ValueKind == JsonValueKind.Number
                ? cps.GetInt32()
                : 0);
    }

    /// <summary>The named pipe a VM's first serial port is pointed at.</summary>
    /// <remarks>
    /// Named for the VM, so two hosts on one workstation do not share a console.
    /// </remarks>
    public static string ConsolePipe(string vmName) =>
        $@"\\.\pipe\envmux-{Config.Slug.From(vmName)}-console";

    /// <summary>
    /// Create the VM, in the one configuration that works.
    /// </summary>
    /// <remarks>
    /// The seeded install media is attached as a second disk rather than as
    /// removable media, because the installer reads the seed out of a raw
    /// partition offset and a DVD drive has no such thing. It is detached again
    /// by <see cref="DetachMediaAsync"/> after the install, which is not
    /// optional: IncusOS checks a UEFI variable and refuses to proceed if it
    /// believes it has booted the install media twice.
    /// </remarks>
    public static async Task CreateAsync(
        HostConfig config,
        string root,
        string mediaVhdx,
        long systemDiskBytes = DefaultSystemDisk,
        long memoryBytes = DefaultMemory,
        int processors = DefaultProcessors,
        Action<string>? report = null,
        CancellationToken ct = default)
    {
        if (systemDiskBytes < MinimumSystemDisk)
        {
            throw new PowershellException(
                $"the system disk is {Gib(systemDiskBytes)} GiB; the IncusOS installer requires at least " +
                $"{Gib(MinimumSystemDisk)} GiB and fails outright below it");
        }

        if (!File.Exists(mediaVhdx))
        {
            throw new PowershellException($"there is no install media at {mediaVhdx}");
        }

        await RequireElevationAsync(
            "Creating a VM", "run this from an Administrator terminal", ct).ConfigureAwait(false);

        report?.Invoke($"creating {config.VmName}");

        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["Name"] = config.VmName,
            ["Root"] = Path.GetFullPath(root),
            ["Media"] = Path.GetFullPath(mediaVhdx),
            ["SwitchName"] = config.Switch,
            ["Mac"] = config.Mac.Replace(":", "", StringComparison.Ordinal)
                                 .Replace("-", "", StringComparison.Ordinal).ToUpperInvariant(),
            ["ConsolePipe"] = ConsolePipe(config.VmName),
            ["SystemBytes"] = systemDiskBytes.ToString(CultureInfo.InvariantCulture),
            ["MemoryBytes"] = memoryBytes.ToString(CultureInfo.InvariantCulture),
            ["Processors"] = processors.ToString(CultureInfo.InvariantCulture),
        };

        await Powershell.CheckedAsync(
            """
            New-Item -ItemType Directory -Path $Root -Force | Out-Null
            $system = Join-Path $Root ($Name + '-system.vhdx')

            New-VM -Name $Name -Generation 2 `
                   -MemoryStartupBytes ([int64]$MemoryBytes) `
                   -NewVHDPath $system -NewVHDSizeBytes ([int64]$SystemBytes) `
                   -SwitchName $SwitchName | Out-Null

            Set-VMProcessor -VMName $Name -Count ([int]$Processors)

            # A host with a ZFS ARC in it does not want its memory taken back.
            Set-VMMemory -VMName $Name -DynamicMemoryEnabled $false

            # Off, and not negotiable: Hyper-V's UEFI cannot enroll the custom
            # keys IncusOS signs itself with.
            Set-VMFirmware -VMName $Name -EnableSecureBoot Off

            # The vTPM half of the same constraint. The key protector has to
            # exist before the TPM can be enabled.
            Set-VMKeyProtector -VMName $Name -NewLocalKeyProtector | Out-Null
            Enable-VMTPM -VMName $Name

            # Off, and this one is not cosmetic. Client Hyper-V takes an
            # automatic checkpoint when a VM starts, which swaps every disk for a
            # differencing .avhdx named with a fresh GUID — so anything that
            # recognised a disk by its filename silently stops, and the install
            # media becomes indistinguishable from the system disk.
            Set-VM -Name $Name -AutomaticCheckpointsEnabled $false

            # Decided before the VM existed, because the install seed names it.
            Set-VMNetworkAdapter -VMName $Name -StaticMacAddress $Mac

            # The installer's log, on a pipe this host can read. The guest is told
            # to use it by the kernel seed; without that this is a port nothing
            # writes to, which costs nothing.
            Set-VMComPort -VMName $Name -Number 1 -Path $ConsolePipe

            # Harmless in this topology, and it removes a whole class of
            # confusion if a bridged mode is ever used from inside.
            Set-VMNetworkAdapter -VMName $Name -MacAddressSpoofing On

            # The seeded install media, as a plain disk: the seed lives at a raw
            # partition offset, which a DVD drive does not have.
            Add-VMHardDiskDrive -VMName $Name -Path $Media

            # Boot the media first. After the install it is detached and the
            # system disk is the only candidate left.
            $drives = @(Get-VMHardDiskDrive -VMName $Name)
            $boot = $drives | Where-Object { $_.Path -eq $Media }
            Set-VMFirmware -VMName $Name -FirstBootDevice $boot

            # An install that reboots into the installer again is the documented
            # failure mode. Stopping instead makes it visible.
            Set-VM -Name $Name -AutomaticStartAction Nothing -AutomaticStopAction ShutDown
            """,
            parameters,
            ct).ConfigureAwait(false);

        report?.Invoke($"{config.VmName} created — secure boot off, vTPM on, mac {config.Mac}");
    }

    /// <summary>
    /// How much a virtual disk has actually been written to.
    /// </summary>
    /// <remarks>
    /// A dynamic VHDX starts at a few megabytes and grows as blocks are
    /// allocated, so this is the closest thing there is to asking whether an
    /// installer has done anything — from outside a machine that cannot be
    /// asked anything. Metadata only, so it works while the VM is running.
    /// </remarks>
    public static async Task<long> DiskBytesAsync(string path, CancellationToken ct = default)
    {
        var result = await Powershell.RunAsync(
            "(Get-VHD -Path $Path -ErrorAction SilentlyContinue).FileSize",
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Path"] = Path.GetFullPath(path) },
            ct).ConfigureAwait(false);

        return result.Ok && long.TryParse(result.Output.Trim(), CultureInfo.InvariantCulture, out var size)
            ? size
            : 0;
    }

    /// <summary>
    /// Shut the VM down, and insist if it will not go.
    /// </summary>
    /// <remarks>
    /// <c>-Force</c> on <c>Stop-VM</c> means "do not prompt", not "pull the
    /// power" — the shutdown is still the ACPI one, which is what an installed
    /// IncusOS should be given. <c>-TurnOff</c> is the hard one, and is the
    /// fallback for a guest that has not implemented the polite path, which
    /// includes one still sitting in its installer.
    /// </remarks>
    public static Task StopAsync(string name, CancellationToken ct = default) =>
        Powershell.CheckedAsync(
            """
            $vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
            if (-not $vm -or $vm.State -eq 'Off') { exit 0 }

            Stop-VM -Name $Name -Force -ErrorAction SilentlyContinue

            $deadline = (Get-Date).AddSeconds(90)
            while ((Get-VM -Name $Name).State -ne 'Off' -and (Get-Date) -lt $deadline) {
              Start-Sleep -Seconds 2
            }

            if ((Get-VM -Name $Name).State -ne 'Off') {
              Stop-VM -Name $Name -TurnOff -Force
            }
            """,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Name"] = name },
            ct);

    /// <summary>Stop the VM if it is up, then unregister it. Idempotent.</summary>
    /// <remarks>
    /// <c>Remove-VM</c> unregisters the machine and its configuration but never
    /// touches its disks — a deliberate Hyper-V safety, and the reason reset
    /// clears the whole vm directory afterwards rather than trusting this to
    /// take the vhdx with it. A VM that is not there is the wanted end state, so
    /// a missing one is not an error.
    /// </remarks>
    public static async Task RemoveAsync(string name, CancellationToken ct = default)
    {
        await StopAsync(name, ct).ConfigureAwait(false);

        await Powershell.CheckedAsync(
            """
            $vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
            if ($vm) { Remove-VM -Name $Name -Force }
            """,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Name"] = name },
            ct).ConfigureAwait(false);
    }

    /// <summary>Start the VM, if it is not already running.</summary>
    public static Task StartAsync(string name, CancellationToken ct = default) =>
        Powershell.CheckedAsync(
            "if ((Get-VM -Name $Name).State -ne 'Running') { Start-VM -Name $Name | Out-Null }",
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Name"] = name },
            ct);

    /// <summary>
    /// Detach the install media and boot from the system disk from now on.
    /// </summary>
    /// <remarks>
    /// The step that is easiest to forget and hardest to diagnose. IncusOS
    /// becomes confused if seed data is still present at boot, and it checks the
    /// <c>IncusOSInstallComplete</c> UEFI variable and refuses to proceed if it
    /// believes it booted the install media again.
    /// </remarks>
    public static async Task<bool> DetachMediaAsync(string name, CancellationToken ct = default)
    {
        var output = await Powershell.CheckedAsync(
            """
            # By slot, and deliberately not by filename. An automatic checkpoint
            # rewrites every path to a differencing .avhdx with a new GUID in it,
            # and a filename comparison then matches nothing — or, if it is
            # written as "the one that is not the system disk", matches the
            # system disk and detaches that instead.
            $drive = Get-VMHardDiskDrive -VMName $Name |
                     Where-Object { $_.ControllerLocation -eq [int]$Slot }

            if (-not $drive) { 'absent'; exit 0 }

            Remove-VMHardDiskDrive -VMName $Name -ControllerType $drive.ControllerType `
                                   -ControllerNumber $drive.ControllerNumber `
                                   -ControllerLocation $drive.ControllerLocation

            $system = Get-VMHardDiskDrive -VMName $Name |
                      Where-Object { $_.ControllerLocation -eq 0 } | Select-Object -First 1

            if ($system) { Set-VMFirmware -VMName $Name -FirstBootDevice $system }
            'detached'
            """,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Name"] = name,
                ["Slot"] = VmDisk.MediaSlot.ToString(CultureInfo.InvariantCulture),
            },
            ct).ConfigureAwait(false);

        return output.Trim() == "detached";
    }

    /// <summary>
    /// Point a VM's COM1 at the pipe envmux reads, if it is not there already.
    /// </summary>
    /// <remarks>
    /// <para>
    /// For a VM created before envmux set this up. Setting a COM port on a VM
    /// that already has one pointed elsewhere is not destructive — nothing else
    /// uses COM1 on an appliance — and doing it unconditionally costs one
    /// cmdlet.
    /// </para>
    /// <para>
    /// Worth being clear about what this does not fix. The other half of a
    /// serial console is the guest agreeing to write to it, and that comes from
    /// the kernel seed, which is baked into the install media. A machine whose
    /// media was written without one will have a COM port that nothing ever
    /// says anything on, no matter what is done from this side.
    /// </para>
    /// <para>
    /// And it does not take effect immediately. Hyper-V creates the pipe when it
    /// builds the VM's devices at start, so setting this on a running machine is
    /// accepted, is visible in its settings, and produces no pipe until the next
    /// time it boots.
    /// </para>
    /// </remarks>
    public static async Task EnsureConsoleAsync(string name, CancellationToken ct = default) =>
        await Powershell.CheckedAsync(
            """
            $port = Get-VMComPort -VMName $Name -Number 1 -ErrorAction SilentlyContinue

            if ($null -eq $port -or $port.Path -ne $Pipe) {
              Set-VMComPort -VMName $Name -Number 1 -Path $Pipe
            }
            """,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Name"] = name,
                ["Pipe"] = ConsolePipe(name),
            },
            ct).ConfigureAwait(false);

    /// <summary>
    /// Take a VM off automatic checkpoints, and remove the ones it has.
    /// </summary>
    /// <remarks>
    /// For a VM created before envmux knew to turn them off. A checkpoint is not
    /// harmless here: it puts a differencing disk in front of every real one, so
    /// the disk sizes envmux reads are of files nothing is writing to and the
    /// paths it reads no longer name what it created.
    /// </remarks>
    public static async Task<int> ClearCheckpointsAsync(string name, CancellationToken ct = default)
    {
        var output = await Powershell.CheckedAsync(
            """
            Set-VM -Name $Name -AutomaticCheckpointsEnabled $false -ErrorAction SilentlyContinue

            $cps = @(Get-VMCheckpoint -VMName $Name -ErrorAction SilentlyContinue)
            foreach ($cp in $cps) { Remove-VMCheckpoint -VMName $Name -Name $cp.Name -Confirm:$false }

            # Merging a differencing disk back into its parent is not instant, and
            # reading a path before it finishes reads the one about to disappear.
            #
            # Waiting on the VM's Status is wrong even though it says 'Merging
            # disks' while it happens: measured on a running VM, removing a
            # checkpoint returns with the status still 'Operating normally' and
            # the merge only starts a moment later, so a loop that waits for the
            # status to stop saying 'merg' never sees it start and exits at once.
            #
            # What the caller actually wants to know is whether the paths are the
            # real ones again, so that is what is waited on: a differencing disk
            # is a .avhdx, and its absence is the merge being over.
            $deadline = (Get-Date).AddMinutes(5)

            while ((Get-Date) -lt $deadline) {
              $differencing = @(Get-VMHardDiskDrive -VMName $Name |
                                Where-Object { $_.Path -like '*.avhdx' })

              if ($differencing.Count -eq 0) { break }

              Start-Sleep -Seconds 2
            }

            $cps.Count
            """,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Name"] = name },
            ct).ConfigureAwait(false);

        return int.TryParse(output.Trim(), CultureInfo.InvariantCulture, out var removed) ? removed : 0;
    }

    /// <summary>
    /// Find the address the VM took on the LAN.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Hyper-V will report a guest's addresses through the data exchange
    /// service, but only when the guest runs the KVP daemon — and IncusOS,
    /// being a minimal appliance, does not. So the reliable route is the
    /// Windows neighbour table: the MAC is known before the VM exists, and once
    /// the VM has answered anything on the LAN there is an entry for it.
    /// </para>
    /// <para>
    /// Which means this only works after the host has talked to the network at
    /// all. That is the same moment the API becomes reachable, so it is not a
    /// real restriction — but it is why this returns null rather than throwing.
    /// </para>
    /// </remarks>
    public static async Task<IPAddress?> AddressAsync(HostConfig config, CancellationToken ct = default)
    {
        var mac = config.Mac.Replace(':', '-').ToUpperInvariant();

        var output = await Powershell.RunAsync(
            """
            $reported = (Get-VMNetworkAdapter -VMName $Name -ErrorAction SilentlyContinue).IPAddresses |
                        Where-Object { $_ -and $_ -notmatch ':' } | Select-Object -First 1
            if ($reported) { $reported; exit 0 }

            $neighbour = Get-NetNeighbor -LinkLayerAddress $Mac -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                         Where-Object { $_.State -ne 'Unreachable' } | Select-Object -First 1
            if ($neighbour) { $neighbour.IPAddress; exit 0 }

            # Nothing in the table, which is not the same as nothing on the wire.
            # Windows only has a neighbour for an address it has had reason to
            # resolve, and it has had no reason to resolve this one: the VM came
            # up, took a lease and started answering, all without Windows ever
            # addressing it. A machine that is up and reachable is invisible here
            # until something asks for it.
            #
            # So ask for all of them. ARP happens before the ping goes anywhere,
            # so a request that times out immediately still leaves an entry
            # behind, and the timeout is what keeps a /24 to a couple of seconds
            # rather than a couple of minutes.
            $local = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                     Where-Object { $_.PrefixLength -ge 24 -and
                                    $_.IPAddress -notlike '127.*' -and
                                    $_.IPAddress -notlike '169.254.*' }

            # Two at most. More than that is somebody's VPN and docker bridges,
            # and the VM is not on those.
            foreach ($net in @($local | Select-Object -First 2)) {
              $prefix = $net.IPAddress -replace '\.\d+$', '.'
              $pings = New-Object System.Collections.ArrayList

              foreach ($last in 1..254) {
                $ping = New-Object System.Net.NetworkInformation.Ping
                [void]$pings.Add($ping.SendPingAsync(($prefix + $last), 200))
              }

              [void][System.Threading.Tasks.Task]::WaitAll($pings.ToArray(), 4000)
            }

            $neighbour = Get-NetNeighbor -LinkLayerAddress $Mac -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                         Where-Object { $_.State -ne 'Unreachable' } | Select-Object -First 1
            if ($neighbour) { $neighbour.IPAddress }
            """,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Name"] = config.VmName,
                ["Mac"] = mac,
            },
            ct).ConfigureAwait(false);

        return output.Ok && IPAddress.TryParse(output.Output.Trim(), out var address) ? address : null;
    }

    /// <summary>
    /// Refuse early, and say what the alternative is.
    /// </summary>
    /// <remarks>
    /// Every Hyper-V cmdlet that changes anything needs administrator rights.
    /// Discovering that after a five-gigabyte copy, in a serialised error
    /// record, is the worst version of a completely predictable failure.
    /// </remarks>
    private static async Task RequireElevationAsync(string what, string alternative, CancellationToken ct)
    {
        if (await Powershell.IsElevatedAsync(ct).ConfigureAwait(false))
        {
            return;
        }

        throw new PowershellException($"{what} needs an elevated prompt — {alternative}.");
    }

    private static string Gib(long bytes) =>
        (bytes / (1024.0 * 1024 * 1024)).ToString("F0", CultureInfo.InvariantCulture);
}
