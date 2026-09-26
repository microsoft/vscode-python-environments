// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Verifies that every exported public API symbol in src/api.ts, src/types.ts,
// and src/publicErrors.ts is documented in docs/README.md.

const fs = require('node:fs');
const path = require('node:path');

function checkDocsCoverage({ repoRoot = path.resolve(__dirname, '../..') } = {}) {
    const sourceFiles = [
        'src/api.ts',
        'src/types.ts',
        'src/publicErrors.ts',
    ];

    const exportPattern = /^export\s+(?:abstract\s+)?(?:interface|type|enum|class|function|const|namespace)\s+([A-Za-z_$][\w$]*)/;
    const skipPattern = /^export\s+(\*|type\s*\{)/;

    const symbols = [];

    for (const sourceFile of sourceFiles) {
        const filePath = path.join(repoRoot, sourceFile);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (skipPattern.test(line)) {
                continue;
            }
            const match = line.match(exportPattern);
            if (match) {
                symbols.push({ file: sourceFile, line: i + 1, name: match[1] });
            }
        }
    }

    const docsPath = path.join(repoRoot, 'docs/README.md');
    const docs = fs.readFileSync(docsPath, 'utf8');

    const undocumented = symbols.filter(sym => !docs.includes(sym.name));

    return undocumented;
}

if (require.main === module) {
    const undocumented = checkDocsCoverage();

    if (undocumented.length > 0) {
        console.error('API symbols not documented in docs/README.md:');
        for (const sym of undocumented) {
            console.error(`  ${sym.file}:${sym.line} — ${sym.name}`);
        }
        process.exit(1);
    }

    const total = checkDocsCoverage()[0] ? 0 : 66; // Rough count; exact count from full run
    const allSymbols = (() => {
        const sf = ['src/api.ts', 'src/types.ts', 'src/publicErrors.ts'];
        const ep = /^export\s+(?:abstract\s+)?(?:interface|type|enum|class|function|const|namespace)\s+([A-Za-z_$][\w$]*)/;
        const sp = /^export\s+(\*|type\s*\{)/;
        let count = 0;
        for (const f of sf) {
            try {
                const content = fs.readFileSync(path.resolve(process.cwd(), f), 'utf8');
                for (const line of content.split('\n')) {
                    if (!sp.test(line) && ep.test(line)) count++;
                }
            } catch {}
        }
        return count;
    })();

    console.log(`✓ All ${allSymbols} API symbols documented in docs/README.md`);
    process.exit(0);
}

module.exports = { checkDocsCoverage };
