const path = require('path');
const { spawn } = require('child_process');

function runNodeStep(stepName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${stepName} failed with exit code ${code}`));
    });
  });
}

async function main() {
  console.log('Starting post-migration flow...');

  await runNodeStep('Finalize schema migration', [
    'scripts/runSqlFile.js',
    'sql/finalize_schema_2026_04_14.sql',
  ]);

  await runNodeStep('Non-mutating verification smoke checks', [
    'scripts/smokeApiVerify.js',
  ]);

  if (String(process.env.RUN_DEEP_SMOKE || '').toLowerCase() === 'true') {
    await runNodeStep('Deep smoke health checks (mutating)', [
      'scripts/smokeApiHealth.js',
    ]);
  } else {
    console.log('Skipping deep smoke checks. Set RUN_DEEP_SMOKE=true to include mutating deep smoke.');
  }

  console.log('Post-migration flow completed successfully.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
