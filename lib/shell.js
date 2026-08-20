const fs = require("fs");
const path = require("path");
const os = require("os");

const START_MARKER = "# >>> npm-guard >>>";
const END_MARKER = "# <<< npm-guard <<<";

function candidateRcFiles() {
  const home = os.homedir();
  return [
    { file: path.join(home, ".bashrc"), style: "posix" },
    { file: path.join(home, ".bash_profile"), style: "posix" },
    { file: path.join(home, ".zshrc"), style: "posix" },
    { file: path.join(home, ".config", "fish", "config.fish"), style: "fish" },
  ].filter((c) => fs.existsSync(c.file));
}

function blockFor(style) {
  if (style === "fish") {
    return `${START_MARKER}\nalias npm 'npm-guard'\n${END_MARKER}\n`;
  }
  return `${START_MARKER}\nalias npm="npm-guard"\n${END_MARKER}\n`;
}

function addAliasToRcFiles() {
  const touched = [];
  for (const { file, style } of candidateRcFiles()) {
    const content = fs.readFileSync(file, "utf8");
    if (content.includes(START_MARKER)) continue; // already installed
    const updated = content.replace(/\s*$/, "\n") + "\n" + blockFor(style);
    fs.writeFileSync(file, updated);
    touched.push(file);
  }
  return touched;
}

function removeAliasFromRcFiles() {
  const touched = [];
  const blockRegex = new RegExp(`\\n?${START_MARKER}[\\s\\S]*?${END_MARKER}\\n?`, "g");
  for (const { file } of candidateRcFiles()) {
    const content = fs.readFileSync(file, "utf8");
    if (!content.includes(START_MARKER)) continue;
    const updated = content.replace(blockRegex, "\n");
    fs.writeFileSync(file, updated);
    touched.push(file);
  }
  return touched;
}

function aliasIsInstalled() {
  return candidateRcFiles().some(({ file }) => fs.readFileSync(file, "utf8").includes(START_MARKER));
}

module.exports = { addAliasToRcFiles, removeAliasFromRcFiles, aliasIsInstalled, candidateRcFiles };
