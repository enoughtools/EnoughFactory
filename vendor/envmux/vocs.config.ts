import { defineConfig } from "vocs";

// The site is built from the same Markdown GitHub renders, under docs/pages.
// One source: a second copy of the docs would drift, and the version people
// read on the web would quietly stop matching the version in the repository.
//
// archive/docs is deliberately not included. It is retired documentation for a
// retired implementation, kept readable on GitHub but not published as if it
// described the current design.
export default defineConfig({
  rootDir: "docs",
  title: "envmux",
  description:
    "Branch-based development sessions on Docker, with a browser whose localhost is the session.",
  iconUrl: "/icon.svg",
  editLink: {
    pattern: "https://github.com/envmux/envmux/edit/main/docs/pages/:path",
    text: "Edit this page on GitHub",
  },
  socials: [{ icon: "github", link: "https://github.com/envmux/envmux" }],
  topNav: [
    { text: "Getting started", link: "/getting-started" },
    { text: "Host", link: "/host" },
    { text: "Routing", link: "/routing" },
    { text: "Plan", link: "/PLAN" },
  ],
  sidebar: [
    { text: "Overview", link: "/" },
    {
      text: "Using it",
      collapsed: false,
      items: [
        { text: "Getting started", link: "/getting-started" },
        { text: "The host", link: "/host" },
        { text: "Configuration", link: "/configuration" },
        { text: "Routing", link: "/routing" },
        { text: "Services", link: "/services" },
        { text: "Tasks", link: "/tasks" },
        { text: "Editor", link: "/editor" },
        { text: "Portal", link: "/portal" },
        { text: "Browser", link: "/browser" },
        { text: "Docker", link: "/docker" },
        { text: "Remote agents", link: "/agents" },
        { text: "CLI reference", link: "/cli" },
      ],
    },
    {
      // Procedures rather than explanations: numbered steps, what you should
      // see, how to roll back. The reasons stay on the pages above.
      text: "Playbooks",
      collapsed: false,
      items: [
        { text: "All playbooks", link: "/playbooks" },
        { text: "Add a remote Incus host", link: "/playbooks/add-remote-host" },
        { text: "Swap to a remote Incus", link: "/playbooks/swap-host" },
        { text: "Prove a host works", link: "/playbooks/prove-host" },
      ],
    },
    {
      text: "Working on it",
      collapsed: false,
      items: [{ text: "Development", link: "/development" }, { text: "Beta launch", link: "/beta" }],
    },
    {
      text: "Design",
      collapsed: false,
      items: [
        { text: "The daemonless plan", link: "/PLAN" },
        { text: "Acceptance", link: "/acceptance" },
      ],
    },
  ],
});
