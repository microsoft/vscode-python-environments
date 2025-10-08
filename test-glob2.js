const glob = require('glob');
const fs = require('fs');
const path = require('path');

// Create test directory structure
const testDir = '/tmp/glob-test-req2';
if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
}
fs.mkdirSync(testDir, { recursive: true });
fs.mkdirSync(path.join(testDir, 'subdir'), { recursive: true });

// Create test files at root
fs.writeFileSync(path.join(testDir, 'requirements.txt'), '');
fs.writeFileSync(path.join(testDir, 'dev-requirements.txt'), '');
fs.writeFileSync(path.join(testDir, 'test-requirements.txt'), '');

// Create test files in subdir
fs.writeFileSync(path.join(testDir, 'subdir', 'requirements.txt'), '');
fs.writeFileSync(path.join(testDir, 'subdir', 'dev-requirements.txt'), '');

// Test different patterns
const patterns = [
    '**/*requirements*.txt',
    '*requirements*.txt',
    '**requirements*.txt',
    '{*requirements*.txt,**/*requirements*.txt}',
];

patterns.forEach(pattern => {
    console.log('\nPattern:', pattern);
    const matched = glob.sync(pattern, { cwd: testDir });
    console.log('Matched:', matched.sort());
});

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });
