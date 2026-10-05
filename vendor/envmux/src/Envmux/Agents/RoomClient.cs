using System.Text;

using Envmux.Config;
using Envmux.Portal;
using Envmux.Session;

namespace Envmux.Agents;

/// <summary>
/// The room's other half: a task in the instance that carries the room over the API.
/// </summary>
/// <remarks>
/// <para>
/// <c>.context/</c> is git-ignored, so it is not in the bundle the repository
/// travels as, and an agent in the instance would otherwise be in a room of
/// its own with nobody in it. Something has to carry the lines across. It used
/// to be a loop on the workstation polling the files API every three seconds;
/// it is now a shell script <em>in the instance</em>, talking to this process's
/// own HTTP API through an Incus proxy device (<see cref="ApiBridge"/>), which
/// is what lets a line cross the moment it is written rather than on the next
/// tick.
/// </para>
/// <para>
/// <b>A task, not a background process.</b> It is declared by envmux the way
/// the remote agent's task is — marked <c>*</c> in the task list, latched like
/// every task, its output a pane you can look at when the room seems quiet. It
/// dies with the session because the instance does: a session ending stops its
/// instance, and a session adopting that instance later starts the task again
/// with that session's token. Its restart policy is <c>always</c>, so a client
/// that fell over is one that was back two seconds later, with its place in the
/// room recovered from the files.
/// </para>
/// <para>
/// <b>What it needs.</b> <c>curl</c>, <c>awk</c>, <c>sed</c> and a GNU
/// <c>date</c>, all of which the golden image has and every Debian does. No
/// <c>jq</c>, because the API speaks a tab-framed text form for exactly this
/// client (<see cref="RoomWire"/>). And two variables in its environment —
/// <see cref="ApiBridge.UrlVariable"/> and <see cref="ApiBridge.TokenVariable"/>
/// — which are in the task's exec and in no file anywhere in the instance.
/// </para>
/// <para>
/// <b>When.</b> A remote agent's session always has one: the room is how the
/// agent is talked to. Any other session has one when the repository has a
/// <c>.context/</c>, which says the convention is in use here and a person or
/// an agent working in the instance would expect the room to be there. A
/// repository without one pays nothing — no task, no script installed, no
/// device attached.
/// </para>
/// </remarks>
internal static class RoomClient
{
    /// <summary>The task's name in the task list and its latch.</summary>
    public const string TaskName = "room";

    /// <summary>The program, on the instance's <c>PATH</c>.</summary>
    public const string Program = "envmux-room";

    /// <summary>Where it is installed. On every account's <c>PATH</c>, as the tools are.</summary>
    public const string InstallPath = "/usr/local/bin/envmux-room";

    /// <summary>What the task list shows for it.</summary>
    public const string Display = "envmux-room (the room, carried over the API)";

    /// <summary>
    /// How long a session that is ending gives the client to post the last lines.
    /// </summary>
    /// <remarks>
    /// The agent's sign-off is written in the instance a moment before the agent
    /// exits, and the session notices the exit on a two-second poll; the client
    /// posts on a loop of about a second. Three seconds is two full turns of
    /// that loop, so the sign-off is on this side before the instance is
    /// stopped, and a session that ends does not end mid-sentence.
    /// </remarks>
    public static readonly TimeSpan Grace = TimeSpan.FromSeconds(3);

    /// <summary>Whether a repository has adopted the convention: it has a <c>.context/</c>.</summary>
    public static bool Wanted(string directory) =>
        Directory.Exists(Path.Combine(directory, Chatroom.ContextDirectory));

    /// <summary>
    /// Whether the client could sign in at all.
    /// </summary>
    /// <remarks>
    /// The API is the portal's, behind the portal's token, and there is no other
    /// credential — deliberately, since a second one would be a second thing to
    /// keep off disk. A project that turns the portal or its token off has
    /// turned the room off too, and the session says so rather than running a
    /// client that would be refused.
    /// </remarks>
    public static bool Reachable(PortalPlan portal) => portal.Enabled && portal.WantsToken;

    /// <summary>Whether a task is this one.</summary>
    public static bool Is(TaskPlan task) =>
        task.IsInternal && task.Name.Equals(TaskName, StringComparison.Ordinal);

    /// <summary>
    /// The task, for a plan.
    /// </summary>
    /// <remarks>
    /// No dependencies: the room should be there before the installs finish,
    /// because the agent's first line is often "waiting for npm ci". Ongoing,
    /// restarted always, and in the working directory, because the room is a
    /// path relative to the repository root.
    /// </remarks>
    /// <exception cref="ConfigException">The portal has no token, so there is nothing for it to sign in with.</exception>
    public static TaskPlan Task(string workdir, PortalPlan portal)
    {
        if (!Reachable(portal))
        {
            throw new ConfigException(
                "the room needs the portal's token, and this project has turned it off — " +
                "set portal.enabled and portal.token to true, or drop .context/ to leave the room out");
        }

        var env = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [EnvKeys.Task] = TaskName,
        };

        foreach (var (key, value) in ApiBridge.Environment(portal.RoomToken))
        {
            env[key] = value;
        }

        return new TaskPlan
        {
            Name = TaskName,
            Kind = TaskKind.Ongoing,
            DependsOn = [],
            ReadyPort = null,
            UrlPattern = null,
            Command = [Program],
            Display = Display,
            Workdir = workdir,
            Env = env,
            Autostart = true,
            Restart = RestartPolicy.Always,
            IsInternal = true,
        };
    }

    /// <summary>
    /// The shell that installs the client, run as root at session start.
    /// </summary>
    /// <remarks>
    /// A quoted heredoc, like <see cref="Bootstrap.EnvironmentScript"/>, so the
    /// script arrives byte for byte — no expansion, no quoting to get wrong. The
    /// terminator is a line the script cannot contain. Written whole every
    /// session, so an adopted instance runs this build's client and not the one
    /// it was made with.
    /// </remarks>
    public static string InstallScript()
    {
        var script = new StringBuilder();

        script.Line("set -eu");
        script.Line("mkdir -p /usr/local/bin");
        script.Line($"cat > {InstallPath} <<'ENVMUX_ROOM_CLIENT'");
        script.Line(Script());
        script.Line("ENVMUX_ROOM_CLIENT");
        script.Line($"chmod 0755 {InstallPath}");

        return script.ToString();
    }

    /// <summary>
    /// The client itself.
    /// </summary>
    /// <remarks>
    /// <para>
    /// One loop, deliberately. Each pass posts whatever was appended to the
    /// live buckets locally since the last pass, then asks the workstation for
    /// everything after its cursor — a request the workstation holds until
    /// there is something, or for a second. So a line from the workstation is
    /// here as soon as it is written, a line from here is there within about a
    /// second, and there is no second process to coordinate with.
    /// </para>
    /// <para>
    /// The echo is the reason it is one loop. A client that posts a line and is
    /// also following the room would see its own line come back on the next
    /// read and append it again. Here the post answers with the lines that
    /// landed on the workstation meanwhile <em>minus the ones just posted</em>,
    /// and a cursor past them — so nothing comes back twice and nothing is
    /// skipped. Two processes, a long poll and a file watcher, would each take
    /// the other's appends for new lines to carry back, and the lock that
    /// prevents it is more shell than this whole script.
    /// </para>
    /// <para>
    /// The first request is the whole of the recent room rather than a delta,
    /// so the last hour is on disk here before the agent reads it. It is
    /// applied by count: for each bucket, only the lines beyond what the local
    /// file already has are appended, because an adopted instance has most of
    /// them from the session before; and a local bucket longer than the
    /// workstation's is one with lines the workstation never got, which the
    /// first ordinary pass sends. Both sides only ever gain lines, which is what
    /// append-only means.
    /// </para>
    /// <para>
    /// Counts are <c>wc -l</c> — terminated lines — and so are the
    /// workstation's, which is why the two agree; see <see cref="RoomFeed.Physical"/>.
    /// </para>
    /// </remarks>
    public static string Script() => """
        #!/bin/sh
        # envmux-room: carries .context/chatroom/ between this instance and the
        # workstation the session was started from, over the envmux API.
        #
        # Written into the instance by envmux when the session starts, and run as
        # the session account in the working directory as the task called `room`.
        # It needs ENVMUX_API_URL and ENVMUX_API_TOKEN in its environment - the API
        # is on loopback here through an Incus proxy device, and the token is the
        # session's own - and, on this machine, curl, awk, sed and a GNU date.
        #
        # One loop: post what was appended here since the last pass, then ask the
        # workstation for everything after our cursor, which it holds until there
        # is something or a second has gone by. The post answers with what landed
        # meanwhile, minus what we sent, so our own lines never come back to us.
        set -u

        url=${ENVMUX_API_URL:?envmux-room: ENVMUX_API_URL is not set}
        token=${ENVMUX_API_TOKEN:?envmux-room: ENVMUX_API_TOKEN is not set}
        room=${ENVMUX_ROOM_DIR:-.context/chatroom}
        wait=${ENVMUX_ROOM_WAIT:-1}

        state=$(mktemp -d "${TMPDIR:-/tmp}/envmux-room.XXXXXX") || exit 1
        trap 'rm -rf "$state"' EXIT
        trap 'exit 0' INT TERM HUP
        hdr=$state/headers
        body=$state/body
        out=$state/out
        known=$state/known
        mkdir -p "$known"

        say() { printf '%s envmux-room: %s\n' "$(date +%H:%M:%S)" "$*"; }

        # The room exists, and the branch that goes back does not carry it: in
        # .git/info/exclude rather than .gitignore, because the repository may not
        # ignore .context/ and committing the room into the branch would be exactly
        # the mistake the convention exists to prevent.
        mkdir -p "$room"
        if [ -d .git ]; then
          mkdir -p .git/info
          grep -qxF '.context/' .git/info/exclude 2>/dev/null || printf '%s\n' '.context/' >> .git/info/exclude
        fi

        cursor=
        down=

        # One request against /api/chat. $1 is the query; $2, when given, is a file
        # to POST as text. The body lands in $body, and the cursor the workstation
        # answers with replaces ours. Non-zero when it did not answer 2xx.
        call() {
          : > "$hdr"
          : > "$body"
          if [ $# -ge 2 ]; then
            printf 'header = "Authorization: Bearer %s"\n' "$token" | \
              curl -sS --max-time 40 --config - -H 'Accept: text/plain' \
              -H 'Content-Type: text/plain; charset=utf-8' -H 'Expect:' --data-binary @"$2" \
              -D "$hdr" -o "$body" "$url/api/chat?$1" 2>/dev/null || return 1
          else
            printf 'header = "Authorization: Bearer %s"\n' "$token" | \
              curl -sS --max-time 40 --config - -H 'Accept: text/plain' \
              -D "$hdr" -o "$body" "$url/api/chat?$1" 2>/dev/null || return 1
          fi
          grep -q '^HTTP/[0-9.]* 2' "$hdr" || return 1
          next=$(sed -n 's/^[Xx]-[Ee]nvmux-[Cc]ursor: *//p' "$hdr" | tr -d '\r' | tail -n 1)
          [ -n "$next" ] && cursor=$next
          return 0
        }

        # Terminated lines in a file, the way wc counts them; zero for no file.
        count() { if [ -f "$1" ]; then wc -l < "$1"; else echo 0; fi; }

        # How many lines of a bucket are already on both sides.
        known_of() { if [ -f "$1" ]; then cat "$1"; else echo 0; fi; }
        key() { printf '%s' "$1" | tr / _; }

        # Append what $body holds - one "bucket<TAB>line" per line - to the local
        # files. Every line, normally. With "sync", only what is beyond the local
        # file's own length: the first response is the whole of the recent room,
        # and an adopted instance already has most of it.
        take() {
          for b in $(cut -f1 "$body" | sort -u); do
            case $b in ""|/*|*..*|*[!A-Za-z0-9_./-]*) continue;; esac
            f=$room/$b
            case $b in */*) mkdir -p "${f%/*}";; esac
            k=$known/$(key "$b")
            got=$(awk -v b="$b" 'index($0, b "\t") == 1 { n++ } END { print n + 0 }' "$body")
            if [ "$1" = sync ]; then
              have=$(count "$f")
              awk -v b="$b" -v have="$have" \
                'index($0, b "\t") == 1 { n++; if (n > have) print substr($0, length(b) + 2) }' "$body" >> "$f"
              echo "$got" > "$k"
            else
              awk -v b="$b" 'index($0, b "\t") == 1 { print substr($0, length(b) + 2) }' "$body" >> "$f"
              echo $(( $(known_of "$k") + got )) > "$k"
            fi
          done
        }

        # This quarter hour and the one before, named the way the room names them.
        live() {
          for ago in 15 0; do
            at="$ago minutes ago"
            printf '%s/%s%02d.txt\n' "$(date -d "$at" +%F)" "$(date -d "$at" +%H)" $(( $(date -d "$at" +%-M) / 15 * 15 ))
          done
        }

        # Post what was appended here since the last pass, in the live buckets.
        # When something was sent, $body holds what landed on the workstation
        # meanwhile - everything but our own lines - and the cursor is past them.
        send() {
          : > "$out"
          for b in $(live); do
            f=$room/$b
            [ -f "$f" ] || continue
            k=$known/$(key "$b")
            have=$(known_of "$k")
            now=$(count "$f")
            [ "$now" -gt "$have" ] || continue
            sed -n "$((have + 1)),${now}p" "$f" | awk -v b="$b" '{ print b "\t" $0 }' >> "$out"
            echo "$now" > "$k.pending"
          done
          [ -s "$out" ] || return 1
          if call "after=$cursor" "$out"; then
            for p in "$known"/*.pending; do [ -f "$p" ] && mv -f "$p" "${p%.pending}"; done
            take all
            return 0
          fi
          rm -f "$known"/*.pending
          return 1
        }

        # The recent room first, whole, so the last hour is here before anyone reads.
        until call "buckets=4"; do
          [ -n "$down" ] || say "the workstation is not answering at $url; waiting for it"
          down=1
          sleep 2
        done
        take sync
        say "following $room over $url"

        while :; do
          send || true
          if call "after=$cursor&wait=$wait"; then
            [ -z "$down" ] || say "the workstation is answering again"
            down=
            take all
          else
            [ -n "$down" ] || say "the workstation is not answering at $url; retrying"
            down=1
            sleep 2
          fi
        done
        """.ReplaceLineEndings("\n");
}
