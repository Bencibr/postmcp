export interface DiffDetail {
  path: string;
  type: 'added' | 'removed' | 'changed';
  oldValue: any;
  newValue: any;
}

export class DiffEngine {
  /**
   * Structurally compares two JSON objects and returns list of differences.
   */
  static compare(obj1: any, obj2: any, path = '$'): DiffDetail[] {
    const diffs: DiffDetail[] = [];

    // Simple types comparison
    if (typeof obj1 !== typeof obj2) {
      diffs.push({ path, type: 'changed', oldValue: obj1, newValue: obj2 });
      return diffs;
    }

    if (obj1 === null || obj2 === null || typeof obj1 !== 'object') {
      if (obj1 !== obj2) {
        diffs.push({ path, type: 'changed', oldValue: obj1, newValue: obj2 });
      }
      return diffs;
    }

    // Array comparison
    if (Array.isArray(obj1) && Array.isArray(obj2)) {
      if (obj1.length !== obj2.length) {
        diffs.push({
          path: `${path}#length`,
          type: 'changed',
          oldValue: obj1.length,
          newValue: obj2.length
        });
      }
      // Compare elements up to min length
      const minLen = Math.min(obj1.length, obj2.length);
      for (let i = 0; i < minLen; i++) {
        diffs.push(...this.compare(obj1[i], obj2[i], `${path}[${i}]`));
      }
      // Elements added in obj2
      for (let i = minLen; i < obj2.length; i++) {
        diffs.push({ path: `${path}[${i}]`, type: 'added', oldValue: undefined, newValue: obj2[i] });
      }
      // Elements removed in obj1
      for (let i = minLen; i < obj1.length; i++) {
        diffs.push({ path: `${path}[${i}]`, type: 'removed', oldValue: obj1[i], newValue: undefined });
      }
      return diffs;
    }

    // One is array and one is object
    if (Array.isArray(obj1) !== Array.isArray(obj2)) {
      diffs.push({ path, type: 'changed', oldValue: obj1, newValue: obj2 });
      return diffs;
    }

    // Object comparison
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);

    const allKeys = new Set([...keys1, ...keys2]);

    for (const key of allKeys) {
      const currentPath = path === '$' ? `$.${key}` : `${path}.${key}`;

      if (keys1.includes(key) && !keys2.includes(key)) {
        diffs.push({ path: currentPath, type: 'removed', oldValue: obj1[key], newValue: undefined });
      } else if (!keys1.includes(key) && keys2.includes(key)) {
        diffs.push({ path: currentPath, type: 'added', oldValue: undefined, newValue: obj2[key] });
      } else {
        diffs.push(...this.compare(obj1[key], obj2[key], currentPath));
      }
    }

    return diffs;
  }

  /**
   * Renders differences in a Markdown representation.
   */
  static renderMarkdownDiff(
    id1: number,
    id2: number,
    status1: number,
    status2: number,
    time1: number,
    time2: number,
    body1: string,
    body2: string,
    format?: 'table' | 'unified'
  ): string {
    let md = `## 🔍 Request History Comparison (ID: ${id1} vs ID: ${id2})\n\n`;

    // 1. Status and Time comparison
    md += `### ⏱️ Metrics\n\n`;
    md += `| Metric | Record #${id1} | Record #${id2} | Comparison |\n`;
    md += `| :--- | :--- | :--- | :--- |\n`;

    const statusDiff = status1 === status2 ? '✅ Match' : `❌ Status Changed (Delta: ${status2 - status1})`;
    const timeDelta = time2 - time1;
    const timeDiff = timeDelta > 0 ? `🔺 Slower by +${timeDelta}ms` : `🔹 Faster by ${timeDelta}ms`;

    md += `| **Status Code** | \`${status1}\` | \`${status2}\` | ${statusDiff} |\n`;
    md += `| **Response Time** | \`${time1} ms\` | \`${time2} ms\` | ${timeDiff} |\n\n`;

    // 2. Response Body Comparison
    md += `### 📦 Response Body Diff\n\n`;

    let parsed1: any;
    let parsed2: any;
    let isJson = true;

    try {
      parsed1 = JSON.parse(body1);
      parsed2 = JSON.parse(body2);
    } catch {
      isJson = false;
    }

    if (isJson) {
      const diffs = this.compare(parsed1, parsed2);
      if (diffs.length === 0) {
        md += `> [!NOTE]\n> **Response bodies are structurally identical.**\n\n`;
      } else if (format === 'unified') {
        // Unified diff format — more readable for large diffs
        md += `\`\`\`diff\n`;
        for (const diff of diffs) {
          const pathStr = diff.path;
          if (diff.type === 'added') {
            md += `+ ${pathStr}: ${JSON.stringify(diff.newValue)}\n`;
          } else if (diff.type === 'removed') {
            md += `- ${pathStr}: ${JSON.stringify(diff.oldValue)}\n`;
          } else {
            md += `~ ${pathStr}: ${JSON.stringify(diff.oldValue)} → ${JSON.stringify(diff.newValue)}\n`;
          }
        }
        md += `\`\`\`\n\n`;
      } else {
        md += `| Path | Type | Value in #${id1} (Old) | Value in #${id2} (New) |\n`;
        md += `| :--- | :--- | :--- | :--- |\n`;

        for (const diff of diffs) {
          let typeIcon = '';
          if (diff.type === 'added') typeIcon = '🟢 Added';
          else if (diff.type === 'removed') typeIcon = '🔴 Removed';
          else typeIcon = '🟡 Changed';

          const oldValText = diff.oldValue !== undefined ? `\`${JSON.stringify(diff.oldValue)}\`` : '*none*';
          const newValText = diff.newValue !== undefined ? `\`${JSON.stringify(diff.newValue)}\`` : '*none*';

          md += `| \`${diff.path}\` | **${typeIcon}** | ${oldValText} | ${newValText} |\n`;
        }
        md += '\n';
      }
    } else {
      // Raw string diff representation
      if (body1 === body2) {
        md += `> [!NOTE]\n> **Response text matches exactly.**\n\n`;
      } else {
        md += `> [!WARNING]\n> **Response bodies are different (Raw Text Mode):**\n\n`;
        md += `**Record #${id1} Length:** ${body1.length} chars | **Record #${id2} Length:** ${body2.length} chars\n\n`;
        
        md += `\`\`\`diff\n`;
        md += `- ${body1.slice(0, 500)}${body1.length > 500 ? '...' : ''}\n`;
        md += `+ ${body2.slice(0, 500)}${body2.length > 500 ? '...' : ''}\n`;
        md += `\`\`\`\n`;
      }
    }

    return md;
  }
}
