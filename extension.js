const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const https = require('https');
const os = require('os');

let outputChannel;
let isCompiling = false;

/**
 * Send telemetry event to Google Analytics 4
 */
function sendTelemetry(eventName, params = {}) {
    try {
        const measurementId = 'G-4TC9Z8LPDR';
        const apiSecret = 'jvuciaIFQ8-LjWpasm_A5w';
        
        const payload = JSON.stringify({
            client_id: vscode.env.machineId,
            events: [{
                name: eventName,
                params: {
                    engagement_time_msec: '100',
                    session_id: Date.now(),
                    ...params
                }
            }]
        });

        const options = {
            hostname: 'www.google-analytics.com',
            path: `/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
            },
            timeout: 5000
        };

        const req = https.request(options, () => {});
        req.on('error', () => {});
        req.on('timeout', () => { req.destroy(); });
        req.write(payload);
        req.end();
    } catch (error) {
        // Silently ignore telemetry errors
    }
}

/**
 * Check if a file exists and is accessible
 */
function fileExists(filePath) {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

/**
 * Check if a file is executable
 */
function isExecutable(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return fileExists(filePath);
    }
}

/**
 * Check if file can be written
 */
function canWrite(filePath) {
    try {
        const dir = path.dirname(filePath);
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Find compiler in common locations
 */
function findCompilerInCommonPaths() {
    const isWindows = process.platform === 'win32';
    const commonPaths = [];

    if (isWindows) {
        const drives = ['C:', 'D:', 'E:', 'F:'];
        const versions = ['3.2.2', '3.2.0', '3.0.4', '3.0.0', '2.6.4'];
        const archs = ['i386-win32', 'x86_64-win64', 'i386-win64'];
        
        drives.forEach(drive => {
            versions.forEach(version => {
                archs.forEach(arch => {
                    commonPaths.push(`${drive}\\FPC\\${version}\\bin\\${arch}\\fpc.exe`);
                });
            });
        });
        
        const programFiles = [
            process.env['ProgramFiles'],
            process.env['ProgramFiles(x86)'],
            process.env['ProgramW6432']
        ].filter(Boolean);
        
        programFiles.forEach(pf => {
            commonPaths.push(
                path.join(pf, 'FreePascal', 'bin', 'fpc.exe'),
                path.join(pf, 'FPC', 'bin', 'fpc.exe')
            );
        });
    } else {
        commonPaths.push(
            '/usr/bin/fpc',
            '/usr/local/bin/fpc',
            '/opt/fpc/bin/fpc',
            '/opt/local/bin/fpc',
            path.join(os.homedir(), '.fpc', 'bin', 'fpc'),
            '/opt/homebrew/bin/fpc',
            '/usr/local/opt/fpc/bin/fpc',
            '/snap/bin/fpc'
        );
    }

    for (const compilerPath of commonPaths) {
        if (isExecutable(compilerPath)) {
            return compilerPath;
        }
    }

    return null;
}

/**
 * Check if a command exists in PATH
 */
function commandExists(command) {
    return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const testCmd = isWindows 
            ? `where ${command} 2>nul`
            : `command -v ${command} 2>/dev/null`;
        
        exec(testCmd, { timeout: 5000 }, (error, stdout) => {
            if (!error && stdout.trim()) {
                const firstPath = stdout.trim().split('\n')[0].trim();
                resolve(firstPath || null);
            } else {
                resolve(null);
            }
        });
    });
}

/**
 * Verify compiler is working
 */
function verifyCompiler(compilerPath) {
    return new Promise((resolve) => {
        const quotedPath = process.platform === 'win32' 
            ? `"${compilerPath}"`
            : `'${compilerPath.replace(/'/g, "'\\''")}'`;
        
        exec(`${quotedPath} -h`, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                resolve(false);
            } else {
                const output = (stdout + stderr).toLowerCase();
                resolve(output.includes('free pascal') || output.includes('fpc'));
            }
        });
    });
}

/**
 * Get the compiler path with multiple fallback strategies
 */
async function getCompilerPath() {
    const config = vscode.workspace.getConfiguration('pascal-auto-run');
    let compilerPath = config.get('compilerPath', '').trim();

    // Strategy 1: Use configured path if valid
    if (compilerPath) {
        if (isExecutable(compilerPath)) {
            const isValid = await verifyCompiler(compilerPath);
            if (isValid) {
                outputChannel.appendLine(`✓ Using configured compiler: ${compilerPath}`);
                return compilerPath;
            } else {
                outputChannel.appendLine(`✗ Configured compiler is invalid: ${compilerPath}`);
            }
        } else {
            outputChannel.appendLine(`✗ Configured compiler not found: ${compilerPath}`);
        }
    }

    // Strategy 2: Check system PATH
    outputChannel.appendLine('⟳ Searching for fpc in system PATH...');
    const pathCompiler = await commandExists('fpc');
    if (pathCompiler) {
        const isValid = await verifyCompiler(pathCompiler);
        if (isValid) {
            outputChannel.appendLine(`✓ Found compiler in PATH: ${pathCompiler}`);
            try {
                await config.update('compilerPath', pathCompiler, vscode.ConfigurationTarget.Global);
            } catch (error) {
                outputChannel.appendLine(`⚠ Could not save compiler path: ${error.message}`);
            }
            return pathCompiler;
        }
    }

    // Strategy 3: Check common installation paths
    outputChannel.appendLine('⟳ Searching in common installation paths...');
    const foundCompiler = findCompilerInCommonPaths();
    if (foundCompiler) {
        const isValid = await verifyCompiler(foundCompiler);
        if (isValid) {
            outputChannel.appendLine(`✓ Found compiler at: ${foundCompiler}`);
            try {
                await config.update('compilerPath', foundCompiler, vscode.ConfigurationTarget.Global);
            } catch (error) {
                outputChannel.appendLine(`⚠ Could not save compiler path: ${error.message}`);
            }
            return foundCompiler;
        }
    }

    // Strategy 4: Ask user to select manually
    outputChannel.appendLine('✗ Compiler not found automatically');
    return await promptUserForCompiler();
}

/**
 * Prompt user to select compiler
 */
async function promptUserForCompiler() {
    const message = vscode.l10n.t('Free Pascal Compiler (fpc) not found. Please select the compiler executable.');
    const selectButton = vscode.l10n.t('Select Compiler');
    const downloadButton = vscode.l10n.t('Download FPC');
    
    const choice = await vscode.window.showErrorMessage(
        message,
        { modal: false },
        selectButton,
        downloadButton
    );

    if (choice === downloadButton) {
        vscode.env.openExternal(vscode.Uri.parse('https://www.freepascal.org/download.html'));
        return null;
    }

    if (choice === selectButton) {
        const filters = process.platform === 'win32' 
            ? { 'Executable': ['exe'], 'All Files': ['*'] }
            : { 'Executable': ['*'], 'All Files': ['*'] };

        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: filters,
            title: vscode.l10n.t('Select Free Pascal Compiler (fpc/fpc.exe)')
        });

        if (uris && uris[0]) {
            const selectedPath = uris[0].fsPath;
            
            if (!fileExists(selectedPath)) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Selected file does not exist.')
                );
                return null;
            }

            const isValid = await verifyCompiler(selectedPath);
            if (!isValid) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Selected file is not a valid Free Pascal Compiler.')
                );
                return null;
            }

            try {
                const config = vscode.workspace.getConfiguration('pascal-auto-run');
                await config.update('compilerPath', selectedPath, vscode.ConfigurationTarget.Global);
                
                // Verify save with multiple retries
                let savedPath = '';
                for (let i = 0; i < 5; i++) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                    const verifyConfig = vscode.workspace.getConfiguration('pascal-auto-run');
                    savedPath = verifyConfig.get('compilerPath', '');
                    if (savedPath === selectedPath) break;
                }
                
                if (savedPath === selectedPath) {
                    vscode.window.showInformationMessage(
                        vscode.l10n.t('Compiler path saved successfully!')
                    );
                    outputChannel.appendLine(`✓ Compiler saved: ${selectedPath}`);
                    return selectedPath;
                } else {
                    throw new Error('Configuration verification failed after retries');
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Failed to save compiler path: {0}', error.message)
                );
                outputChannel.appendLine(`✗ Save failed: ${error.message}`);
                return null;
            }
        }
    }

    return null;
}

/**
 * Kill running processes with the same name as executable
 */
function killProcessByName(exeName) {
    return new Promise((resolve) => {
        const baseName = path.basename(exeName, '.exe');
        const isWindows = process.platform === 'win32';
        
        if (isWindows) {
            exec(`taskkill /F /IM "${baseName}.exe" 2>nul`, { timeout: 5000 }, () => {
                resolve();
            });
        } else {
            exec(`pkill -9 "${baseName}" 2>/dev/null`, { timeout: 5000 }, () => {
                resolve();
            });
        }
    });
}

/**
 * Delete file with retries
 */
async function deleteFileWithRetry(filePath, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                return true;
            }
            return true;
        } catch (error) {
            if (i === maxRetries - 1) {
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 200 * (i + 1)));
        }
    }
    return false;
}

/**
 * Clean up compilation artifacts
 */
async function cleanupFiles(filePath) {
    const config = vscode.workspace.getConfiguration('pascal-auto-run');
    const shouldCleanup = config.get('cleanupAfterCompile', false);

    if (!shouldCleanup) return;

    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));
    
    const extensions = ['.o', '.ppu', '.compiled'];
    const filesToDelete = extensions.map(ext => path.join(dir, baseName + ext));

    setTimeout(async () => {
        for (const file of filesToDelete) {
            if (fs.existsSync(file)) {
                const deleted = await deleteFileWithRetry(file, 3);
                if (deleted) {
                    outputChannel.appendLine(`✓ Cleaned up: ${file}`);
                } else {
                    outputChannel.appendLine(`⚠ Could not delete: ${file}`);
                }
            }
        }
    }, 3000);
}

/**
 * Escape path for shell command (cross-platform)
 */
function escapePathForShell(filePath, isWindows) {
    if (isWindows) {
        return `'${filePath.replace(/'/g, "''")}'`;
    } else {
        return `"${filePath.replace(/(["`$\\])/g, '\\$1')}"`;
    }
}

/**
 * Create compilation command for Windows (PowerShell)
 */
function createWindowsCommand(compilerPath, compilerOptions, filePath, exePath, pauseAfterExecution) {
    const compiler = escapePathForShell(compilerPath, true);
    const file = escapePathForShell(filePath, true);
    const exe = escapePathForShell(exePath, true);
    const baseName = path.basename(exePath, '.exe');
    
    const scriptLines = [
        `cls`,
        // Kill any running instance
        `Get-Process -Name '${baseName}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
        `Start-Sleep -Milliseconds 200`,
        // Delete old executable with retries
        `for ($i = 0; $i -lt 5; $i++) {`,
        `  if (Test-Path ${exe}) {`,
        `    try {`,
        `      Remove-Item ${exe} -Force -ErrorAction Stop`,
        `      break`,
        `    } catch {`,
        `      if ($i -eq 4) { Write-Host 'Warning: Could not delete old executable' -ForegroundColor Yellow }`,
        `      Start-Sleep -Milliseconds 200`,
        `    }`,
        `  } else { break }`,
        `}`,
        // Compile
        `& ${compiler} ${compilerOptions} ${file}`,
        `$compileResult = $LASTEXITCODE`,
        `if ($compileResult -eq 0) {`,
        `  if (Test-Path ${exe}) {`,
        `    Write-Host ''`,
        `    Write-Host 'Compilation successful! Running...' -ForegroundColor Green`,
        `    Write-Host ''`,
        `    & ${exe}`,
        `    $runResult = $LASTEXITCODE`,
    ];

    if (pauseAfterExecution) {
        scriptLines.push(
            `    Write-Host ''`,
            `    Write-Host 'Press any key to continue...' -ForegroundColor Yellow`,
            `    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')`
        );
    }

    scriptLines.push(
        `  } else {`,
        `    Write-Host ''`,
        `    Write-Host 'Error: Executable was not created!' -ForegroundColor Red`,
        `  }`,
        `} else {`,
        `  Write-Host ''`,
        `  Write-Host 'Compilation failed!' -ForegroundColor Red`,
        `}`
    );

    return `Invoke-Command -ScriptBlock { ${scriptLines.join('; ')} }`;
}

/**
 * Create compilation commands for Unix/macOS (Bash)
 */
function createUnixCommands(compilerPath, compilerOptions, filePath, exePath, pauseAfterExecution) {
    const compiler = escapePathForShell(compilerPath, false);
    const file = escapePathForShell(filePath, false);
    const exe = escapePathForShell(exePath, false);
    const baseName = path.basename(exePath);
    
    const commands = [
        `clear`,
        `pkill -9 "${baseName}" 2>/dev/null || true`,
        `sleep 0.2`,
        `rm -f ${exe} 2>/dev/null || true`,
        `echo "Compiling..."`,
        `${compiler} ${compilerOptions} ${file}`,
        `COMPILE_RESULT=$?`,
        `if [ $COMPILE_RESULT -eq 0 ]; then`,
        `  if [ -f ${exe} ]; then`,
        `    echo ""`,
        `    echo "Compilation successful! Running..."`,
        `    echo ""`,
        `    chmod +x ${exe}`,
        `    ${exe}`,
        `    RUN_RESULT=$?`,
    ];

    if (pauseAfterExecution) {
        commands.push(
            `    echo ""`,
            `    read -p "Press Enter to continue..." -r`
        );
    }

    commands.push(
        `  else`,
        `    echo ""`,
        `    echo "Error: Executable was not created!"`,
        `  fi`,
        `else`,
        `  echo ""`,
        `  echo "Compilation failed!"`,
        `fi`
    );

    return commands;
}

/**
 * Validate Pascal file
 */
function validatePascalFile(filePath) {
    if (!fileExists(filePath)) {
        return { valid: false, error: 'File does not exist' };
    }

    const fileExt = path.extname(filePath).toLowerCase();
    if (!['.pas', '.pp', '.inc', '.lpr'].includes(fileExt)) {
        return { valid: false, error: 'Not a Pascal file (.pas, .pp, .inc, .lpr)' };
    }

    const dir = path.dirname(filePath);
    if (!canWrite(dir)) {
        return { valid: false, error: 'Directory is not writable' };
    }

    // Check for problematic characters in path
    if (filePath.includes('\n') || filePath.includes('\r')) {
        return { valid: false, error: 'File path contains invalid characters' };
    }

    return { valid: true };
}

/**
 * Compile and run Pascal file
 */
async function compileAndRun() {
    if (isCompiling) {
        vscode.window.showWarningMessage(
            vscode.l10n.t('A compilation is already in progress')
        );
        return;
    }

    const editor = vscode.window.activeTextEditor;
    
    if (!editor) {
        vscode.window.showErrorMessage(vscode.l10n.t('No active editor found'));
        return;
    }

    const document = editor.document;
    const filePath = document.fileName;

    // Validate file
    const validation = validatePascalFile(filePath);
    if (!validation.valid) {
        vscode.window.showErrorMessage(
            vscode.l10n.t('Cannot compile: {0}', validation.error)
        );
        return;
    }

    isCompiling = true;

    try {
        // Save before compile if configured
        const config = vscode.workspace.getConfiguration('pascal-auto-run');
        const saveBeforeCompile = config.get('saveBeforeCompile', true);
        
        if (saveBeforeCompile && document.isDirty) {
            const saved = await document.save();
            if (!saved) {
                vscode.window.showErrorMessage(vscode.l10n.t('Failed to save file'));
                return;
            }
        }

        // Show output channel
        outputChannel.show(true);
        outputChannel.clear();
        outputChannel.appendLine('═'.repeat(60));
        outputChannel.appendLine('Pascal Auto Run - Compilation Started');
        outputChannel.appendLine('═'.repeat(60));
        outputChannel.appendLine(`File: ${filePath}`);
        outputChannel.appendLine(`Platform: ${process.platform} (${os.arch()})`);
        outputChannel.appendLine(`Time: ${new Date().toLocaleString()}`);
        outputChannel.appendLine('');

        // Get and verify compiler
        const compilerPath = await getCompilerPath();
        if (!compilerPath) {
            outputChannel.appendLine('✗ Compilation aborted: No compiler available');
            return;
        }

        // Send telemetry
        sendTelemetry('compile_clicked', {
            platform: process.platform,
            file_extension: path.extname(filePath)
        });

        outputChannel.appendLine(`Compiler: ${compilerPath}`);

        const dir = path.dirname(filePath);
        const baseName = path.basename(filePath, path.extname(filePath));
        const exePath = process.platform === 'win32' 
            ? path.join(dir, `${baseName}.exe`)
            : path.join(dir, baseName);

        const compilerOptions = config.get('compilerOptions', '').trim();
        const pauseAfterExecution = config.get('pauseAfterExecution', true);

        if (compilerOptions) {
            outputChannel.appendLine(`Options: ${compilerOptions}`);
        }

        outputChannel.appendLine('');

        // Kill any running instance and clean up
        outputChannel.appendLine('⟳ Preparing compilation environment...');
        await killProcessByName(exePath);
        await new Promise(resolve => setTimeout(resolve, 300));
        
        if (fileExists(exePath)) {
            const deleted = await deleteFileWithRetry(exePath, 5);
            if (deleted) {
                outputChannel.appendLine('✓ Old executable deleted');
            } else {
                outputChannel.appendLine('⚠ Could not delete old executable (may cause compilation error)');
            }
        }

        outputChannel.appendLine('✓ Environment ready');
        outputChannel.appendLine('');
        outputChannel.appendLine('Starting compilation in terminal...');
        outputChannel.appendLine('═'.repeat(60));

        // Create terminal
        const shellPath = process.platform === 'win32' 
            ? 'powershell.exe'
            : undefined;

        const terminal = vscode.window.createTerminal({
            name: 'Pascal Auto Run',
            cwd: dir,
            shellPath: shellPath
        });

        terminal.show();

        // Generate and send commands
        const isWindows = process.platform === 'win32';
        
        if (isWindows) {
            const command = createWindowsCommand(
                compilerPath,
                compilerOptions,
                filePath,
                exePath,
                pauseAfterExecution
            );
            terminal.sendText(command);
        } else {
            const commands = createUnixCommands(
                compilerPath,
                compilerOptions,
                filePath,
                exePath,
                pauseAfterExecution
            );
            commands.forEach(cmd => terminal.sendText(cmd));
        }

        // Schedule cleanup
        cleanupFiles(filePath);

    } catch (error) {
        outputChannel.appendLine('');
        outputChannel.appendLine(`✗ Unexpected error: ${error.message}`);
        outputChannel.appendLine(`Stack: ${error.stack}`);
        vscode.window.showErrorMessage(
            vscode.l10n.t('Compilation error: {0}', error.message)
        );
    } finally {
        isCompiling = false;
    }
}

/**
 * Command to manually select compiler
 */
async function selectCompiler() {
    outputChannel.appendLine('Manual compiler selection requested');
    const compilerPath = await promptUserForCompiler();
    
    if (compilerPath) {
        outputChannel.appendLine(`✓ Compiler selected: ${compilerPath}`);
    } else {
        outputChannel.appendLine('✗ Compiler selection cancelled');
    }
}

/**
 * Activation function
 */
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Pascal Auto Run');
    
    sendTelemetry('extension_activated', {
        platform: process.platform,
        vscode_version: vscode.version,
        node_version: process.version
    });

    const runCommand = vscode.commands.registerCommand(
        'pascal-auto-run.run',
        compileAndRun
    );

    const selectCompilerCommand = vscode.commands.registerCommand(
        'pascal-auto-run.selectCompiler',
        selectCompiler
    );

    context.subscriptions.push(runCommand);
    context.subscriptions.push(selectCompilerCommand);
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine('═'.repeat(60));
    outputChannel.appendLine('Pascal Auto Run Extension Activated');
    outputChannel.appendLine('═'.repeat(60));
    outputChannel.appendLine(`Version: 1.0.0`);
    outputChannel.appendLine(`Platform: ${process.platform} (${os.arch()})`);
    outputChannel.appendLine(`VS Code: ${vscode.version}`);
    outputChannel.appendLine(`Node.js: ${process.version}`);
    outputChannel.appendLine('═'.repeat(60));
}

/**
 * Deactivation function
 */
function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}

module.exports = {
    activate,
    deactivate
};
