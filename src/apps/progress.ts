/**
 * What an app's first start says while the programs it needs are installed
 * (docs/APPS.md "Lifecycle"). The installer (`toolchain install`) writes lines
 * for people who know Debian; a person opening an app from the dock reads
 * these sentences, and the installer's own lines stay under "Show details".
 *
 * No fraction and no time left: the installer measures neither. A build on
 * the server reports the package it is at ("package 12 of 71"), and that is
 * shown as the server says it; apt names each package, and those are counted.
 */

/** The sentence shown from the moment an app's first start begins to install */
export function firstInstallText(appName: string): string {
  return `${appName} needs some programs. They are being downloaded. This happens once.`;
}

/**
 * The sentence for one line of the installer's output, or null when the line
 * says nothing a person needs (the sentence before it stays).
 */
export function plainInstallLine(line: string): string | null {
  const l = line.trim();
  if (/^Installing Debian first/.test(l)) return 'The Linux system that these programs run on is being downloaded. This happens once.';
  if (/^Debian \S+ .*streamed on demand/.test(l)) return 'The Linux system is in place. The programs come next.';
  if (/^No prebuilt .* layer/.test(l)) return 'This server has no ready-made copy of the programs. Installing them takes a few minutes.';
  // A set of packages nobody asked for before is built on the server (src/debian/package-sets.ts):
  // its own sentences say how far the build is, and that the wait happens once for everyone
  if (/^The server is /.test(l)) return `${l} This build happens once: the next person gets these programs in seconds.`;
  if (/^No ready-made copy of /.test(l)) return l;
  if (/packages to add/.test(l)) return 'The programs are being added.';
  if (/packages? installed (in|from) /.test(l) || /installed with apt in /.test(l)) return 'The programs are installed.';
  if (/already installed/.test(l)) return 'The programs are already here.';
  if (/^(Get:\d|Fetched |Unpacking |Setting up |Preparing to unpack |Selecting previously)/.test(l)) return 'The programs are being installed. This takes a few minutes.';
  return null;
}

/**
 * The sentences of one install, in order: `plainInstallLine`, and apt's own
 * count. apt says how many packages it adds ("71 newly installed") and then
 * names each as it downloads, unpacks and sets it up, so the sentence says
 * which package of how many that is. Without apt's total no count is shown.
 */
export function installProgress(): (line: string) => string | null {
  let total = 0;
  const at = { Get: 0, Unpacking: 0, 'Setting up': 0 };
  const doing = { Get: 'downloaded', Unpacking: 'unpacked', 'Setting up': 'set up' };
  return (line) => {
    const l = line.trim();
    const n = /(\d+) newly installed/.exec(l);
    if (n) { total = Number(n[1]); return null; }
    const step = /^(Get|Unpacking|Setting up)[: ]/.exec(l)?.[1] as keyof typeof at | undefined;
    if (!total) return plainInstallLine(line);
    // (apt's lines between two packages say nothing new: the count stays)
    if (!step) return /^(Fetched |Preparing to unpack |Selecting previously)/.test(l) ? null : plainInstallLine(line);
    at[step] = Math.min(total, at[step] + 1);
    return `Package ${at[step]} of ${total} is being ${doing[step]}.`;
  };
}
