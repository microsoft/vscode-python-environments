const glob = require('glob');
const fs = require('fs');
const path = require('path');

// Create test directory
const testDir = '/tmp/glob-test-req';
if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
}

// Create test files
fs.writeFileSync(path.join(testDir, 'requirements.txt'), '');
fs.writeFileSync(path.join(testDir, 'dev-requirements.txt'), '');
fs.writeFileSync(path.join(testDir, 'test-requirements.txt'), '');

// Test pattern
const pattern = '**/*requirements*.txt';
console.log('Testing pattern:', pattern);
console.log('CWD:', testDir);

const matched = glob.sync(pattern, { cwd: testDir });
console.log('Matched files:', matched);

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });
