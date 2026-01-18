const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const https = require('https');
const os = require('os');

let outputChannel;

/**
 * Send telemetry event to Google Analytics 4
 */
function sendTelemetry(eventName, params = {}) {
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
        }
    };

    const req = https.request(options, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
}

/**
 * Check if a file exists and is executable
 */
function isExecutable(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return fs.existsSync(filePath);
    }
}

/**
 * Find compiler in common locations
 */
function findCompilerInCommonPaths() {
    const isWindows = process.platform === 'win32';
    const commonPaths = [];

    if (isWindows) {
        // Windows common paths
        const drives = ['C:', 'D:', 'E:'];
        const versions = ['3.2.2', '3.2.0', '3.0.4', '3.0.0'];
        const archs = ['i386-win32', 'x86_64-win64'];
        
        drives.forEach(drive => {
            versions.forEach(version => {
                archs.forEach(arch => {
                    commonPaths.push(`${drive}\\FPC\\${version}\\bin\\${arch}\\fpc.exe`);
                });
            });
        });
        
        // Also check Program Files
        const programFiles = [
            process.env['ProgramFiles'],
            process.env['ProgramFiles(x86)'],
            process.env['ProgramW6432']
        ].filter(Boolean);
        
        programFiles.forEach(pf => {
            commonPaths.push(path.join(pf, 'FreePascal', 'bin', 'fpc.exe'));
        });
    } else {
        // Unix/macOS common paths
        commonPaths.push(
            '/usr/bin/fpc',
            '/usr/local/bin/fpc',
            '/opt/fpc/bin/fpc',
            path.join(os.homedir(), '.fpc', 'bin', 'fpc'),
            '/opt/homebrew/bin/fpc',
            '/usr/local/opt/fpc/bin/fpc'
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
        const testCmd = process.platform === 'win32' 
            ? `where ${command} 2>nul`
            : `which ${command} 2>/dev/null`;
        
        exec(testCmd, (error, stdout) => {
            if (!error && stdout.trim()) {
                const firstPath = stdout.trim().split('\n')[0];
                resolve(firstPath);
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
        exec(`"${compilerPath}" -h`, { timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
                resolve(false);
            } else {
                const output = stdout + stderr;
                resolve(output.toLowerCase().includes('free pascal'));
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
                outputChannel.appendLine(`Using configured compiler: ${compilerPath}`);
                return compilerPath;
            } else {
                outputChannel.appendLine(`Configured compiler is invalid: ${compilerPath}`);
            }
        } else {
            outputChannel.appendLine(`Configured compiler not found: ${compilerPath}`);
        }
    }

    // Strategy 2: Check system PATH
    outputChannel.appendLine('Searching for fpc in system PATH...');
    const pathCompiler = await commandExists('fpc');
    if (pathCompiler) {
        const isValid = await verifyCompiler(pathCompiler);
        if (isValid) {
            outputChannel.appendLine(`Found compiler in PATH: ${pathCompiler}`);
            // Save to config for future use
            await config.update('compilerPath', pathCompiler, vscode.ConfigurationTarget.Global);
            return pathCompiler;
        }
    }

    // Strategy 3: Check common installation paths
    outputChannel.appendLine('Searching in common installation paths...');
    const foundCompiler = findCompilerInCommonPaths();
    if (foundCompiler) {
        const isValid = await verifyCompiler(foundCompiler);
        if (isValid) {
            outputChannel.appendLine(`Found compiler at: ${foundCompiler}`);
            // Save to config
            await config.update('compilerPath', foundCompiler, vscode.ConfigurationTarget.Global);
            return foundCompiler;
        }
    }

    // Strategy 4: Ask user to select manually
    outputChannel.appendLine('Compiler not found automatically.');
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
            : { 'All Files': ['*'] };

        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: filters,
            title: vscode.l10n.t('Select Free Pascal Compiler (fpc/fpc.exe)')
        });

        if (uris && uris[0]) {
            const selectedPath = uris[0].fsPath;
            
            // Verify the selected compiler
            const isValid = await verifyCompiler(selectedPath);
            if (!isValid) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Selected file is not a valid Free Pascal Compiler.')
                );
                return null;
            }

            // Save to global configuration
            try {
                const config = vscode.workspace.getConfiguration('pascal-auto-run');
                await config.update('compilerPath', selectedPath, vscode.ConfigurationTarget.Global);
                
                // Verify save with retry
                let savedPath = '';
                for (let i = 0; i < 3; i++) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const verifyConfig = vscode.workspace.getConfiguration('pascal-auto-run');
                    savedPath = verifyConfig.get('compilerPath', '');
                    if (savedPath === selectedPath) break;
                }
                
                if (savedPath === selectedPath) {
                    vscode.window.showInformationMessage(
                        vscode.l10n.t('Compiler path saved successfully!')
                    );
                    outputChannel.appendLine(`Compiler saved: ${selectedPath}`);
                    return selectedPath;
                } else {
                    throw new Error('Configuration verification failed');
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Failed to save compiler path: {0}', error.message)
                );
                return null;
            }
        }
    }

    return null;
}

/**
 * Clean up compilation artifacts
 */
function cleanupFiles(filePath) {
    const config = vscode.workspace.getConfiguration('pascal-auto-run');
    const shouldCleanup = config.get('cleanupAfterCompile', false);

    if (!shouldCleanup) return;

    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));
    
    const extensions = ['.o', '.ppu', '.compiled'];
    const filesToDelete = extensions.map(ext => path.join(dir, baseName + ext));

    setTimeout(() => {
        filesToDelete.forEach(file => {
            if (fs.existsSync(file)) {
                try {
                    fs.unlinkSync(file);
                    outputChannel.appendLine(`Cleaned up: ${file}`);
                } catch (error) {
                    outputChannel.appendLine(`Failed to delete ${file}: ${error.message}`);
                }
            }
        });
    }, 2000);
}

/**
 * Escape path for shell command (cross-platform)
 */
function escapePathForShell(filePath, isWindows) {
    if (isWindows) {
        // PowerShell: use single quotes and escape internal single quotes
        return `'${filePath.replace(/'/g, "''")}'`;
    } else {
        // Bash: use double quotes and escape special chars
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
    
    const scriptLines = [
        `cls`,
        `& ${compiler} ${compilerOptions} ${file}`,
        `if ($LASTEXITCODE -eq 0) {`,
        `  Write-Host ''`,
        `  Write-Host 'Compilation successful! Running...' -ForegroundColor Green`,
        `  Write-Host ''`,
        `  & ${exe}`,
    ];

    if (pauseAfterExecution) {
        scriptLines.push(
            `  Write-Host ''`,
            `  Write-Host 'Press any key to continue...' -ForegroundColor Yellow`,
            `  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')`
        );
    }

    scriptLines.push(
        `} else {`,
        `  Write-Host ''`,
        `  Write-Host 'Compilation failed!' -ForegroundColor Red`,
        `}`
    );

    // Create a PowerShell script block that won't echo the command
    return `Invoke-Command -ScriptBlock { ${scriptLines.join('; ')} }`;
}

/**
 * Create compilation commands for Unix/macOS (Bash)
 */
function createUnixCommands(compilerPath, compilerOptions, filePath, exePath, pauseAfterExecution) {
    const compiler = escapePathForShell(compilerPath, false);
    const file = escapePathForShell(filePath, false);
    const exe = escapePathForShell(exePath, false);
    
    const commands = [
        `clear`,
        `echo "=== Compiling Pascal program ==="`,
        `${compiler} ${compilerOptions} ${file}`,
        `EXIT_CODE=$?`,
        `if [ $EXIT_CODE -eq 0 ]; then`,
        `  echo ""`,
        `  echo "=== Compilation successful! Running program ==="`,
        `  echo ""`,
        `  chmod +x ${exe}`,
        `  ${exe}`,
        `  PROGRAM_EXIT=$?`,
        `  echo ""`,
        `  echo "=== Program exited with code: $PROGRAM_EXIT ==="`,
    ];

    if (pauseAfterExecution) {
        commands.push(
            `  echo ""`,
            `  read -p "Press Enter to continue..." -r`
        );
    }

    commands.push(
        `else`,
        `  echo ""`,
        `  echo "=== Compilation failed! ==="`,
        `  echo "Exit code: $EXIT_CODE"`,
        `fi`
    );

    return commands;
}

/**
 * Compile and run Pascal file
 */
async function compileAndRun() {
    const editor = vscode.window.activeTextEditor;
    
    if (!editor) {
        vscode.window.showErrorMessage(vscode.l10n.t('No active editor found'));
        return;
    }

    const document = editor.document;
    const filePath = document.fileName;
    const fileExt = path.extname(filePath).toLowerCase();

    // Validate Pascal file
    if (!['.pas', '.pp', '.inc', '.lpr'].includes(fileExt)) {
        vscode.window.showWarningMessage(
            vscode.l10n.t('Current file is not a Pascal file (.pas, .pp, .inc, .lpr)')
        );
        return;
    }

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

    // Get and verify compiler
    outputChannel.show(true);
    outputChannel.clear();
    outputChannel.appendLine('='.repeat(60));
    outputChannel.appendLine('Pascal Auto Run');
    outputChannel.appendLine('='.repeat(60));
    outputChannel.appendLine(`File: ${filePath}`);
    outputChannel.appendLine(`Platform: ${process.platform}`);
    outputChannel.appendLine('');

    const compilerPath = await getCompilerPath();
    if (!compilerPath) {
        outputChannel.appendLine('ERROR: No compiler available');
        return;
    }

    // Send telemetry
    sendTelemetry('compile_clicked', {
        platform: process.platform,
        file_extension: fileExt
    });

    outputChannel.appendLine(`Compiler: ${compilerPath}`);
    outputChannel.appendLine('');

    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));
    const exePath = process.platform === 'win32' 
        ? path.join(dir, `${baseName}.exe`)
        : path.join(dir, baseName);

    const compilerOptions = config.get('compilerOptions', '').trim();
    const pauseAfterExecution = config.get('pauseAfterExecution', true);

    if (compilerOptions) {
        outputChannel.appendLine(`Compiler options: ${compilerOptions}`);
    }

    // Create terminal with appropriate shell
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
        // Clear terminal first
        terminal.sendText('cls');
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

    outputChannel.appendLine('Commands sent to terminal');
    outputChannel.appendLine('='.repeat(60));

    // Schedule cleanup
    cleanupFiles(filePath);
}

/**
 * Command to manually select compiler
 */
async function selectCompiler() {
    outputChannel.appendLine('Manual compiler selection requested');
    const compilerPath = await promptUserForCompiler();
    
    if (compilerPath) {
        outputChannel.appendLine(`Compiler selected: ${compilerPath}`);
    } else {
        outputChannel.appendLine('Compiler selection cancelled');
    }
}

/**
 * Activation function
 */
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Pascal Auto Run');
    
    sendTelemetry('extension_activated', {
        platform: process.platform,
        vscode_version: vscode.version
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

    outputChannel.appendLine('Pascal Auto Run extension activated!');
    outputChannel.appendLine(`Platform: ${process.platform}`);
    outputChannel.appendLine(`VS Code version: ${vscode.version}`);
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