/**
 * CLI Logger - Single-line progress updates like Claude Code CLI
 *
 * Usage:
 *   cliLogger.progress('Processing...') - Updates same line
 *   cliLogger.success('Done!') - New line with result
 *   cliLogger.error('Failed!') - New line with error
 *   cliLogger.clear() - Clear current line
 */

class CLILogger {
  constructor() {
    this.currentLine = '';
    this.isProgress = false;
    this.animationInterval = null;
    this.animationDots = 0;
    this.isAnimating = false; // Track if we're in animation mode
    this.indentStack = []; // Stack of messages showing delegation hierarchy
    this.indentLevel = 0;

    // Intercept console methods to auto-clear progress
    this.setupConsoleIntercept();
  }

  setupConsoleIntercept() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;
    const self = this;

    console.log = function(...args) {
      self.clearProgress();
      originalLog.apply(console, args);
    };

    console.error = function(...args) {
      self.clearProgress();
      originalError.apply(console, args);
    };

    console.warn = function(...args) {
      self.clearProgress();
      originalWarn.apply(console, args);
    };

    console.info = function(...args) {
      self.clearProgress();
      originalInfo.apply(console, args);
    };
  }

  /**
   * Push a message to the delegation stack (indented)
   */
  pushIndent(message) {
    this.indentLevel++;
    const indent = '  '.repeat(this.indentLevel);
    this.indentStack.push({ message, indent, level: this.indentLevel });
    this.progress(`${indent}→ ${message}`);
  }

  /**
   * Pop the last delegation from stack and restore parent context
   */
  popIndent() {
    if (this.indentStack.length > 0) {
      this.indentStack.pop();
      this.indentLevel = Math.max(0, this.indentLevel - 1);

      // Clear and restore parent context
      this.clear();

      // Re-render parent if exists
      if (this.indentStack.length > 0) {
        const parent = this.indentStack[this.indentStack.length - 1];
        this.progress(`${parent.indent}→ ${parent.message}`);
      }
    } else {
      this.indentLevel = 0;
    }
  }

  /**
   * Clear all indentation stack
   */
  clearStack() {
    this.indentStack = [];
    this.indentLevel = 0;
    this.clear();
  }

  /**
   * Get current indent string
   */
  getIndent() {
    return '  '.repeat(this.indentLevel);
  }

  /**
   * Show planning state with animated spinning stick
   */
  planning(prefix) {
    // Stop any existing animation
    this.stopAnimation();

    const baseMessage = prefix || 'Thinking';
    this.animationDots = 0;
    this.isAnimating = true;
    const spinnerChars = ['|', '/', '-', '\\'];

    // Initial render
    this.progress(`${baseMessage} ${spinnerChars[0]}`);

    // Start animation
    this.animationInterval = setInterval(() => {
      this.animationDots = (this.animationDots + 1) % spinnerChars.length;
      const spinner = spinnerChars[this.animationDots];
      this.progress(`${baseMessage} ${spinner}`);
    }, 150);
  }

  /**
   * Stop animation if running
   */
  stopAnimation() {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = null;
      this.animationDots = 0;
      this.isAnimating = false;
    }
  }

  /**
   * Update the same line with progress (no newline)
   */
  progress(message) {
    // Stop animation if it's running and we're not in animation mode
    if (this.animationInterval && !this.isAnimating && !message.includes('...')) {
      this.stopAnimation();
    }

    // Clear previous line
    if (this.isProgress) {
      process.stdout.write('\r\x1b[K');
    }

    // Write new message
    process.stdout.write(message);
    this.currentLine = message;
    this.isProgress = true;
  }

  /**
   * Complete progress and print result on new line
   */
  success(message) {
    this.clearProgress();
    console.log(message);
  }

  /**
   * Print error on new line
   */
  error(message) {
    this.clearProgress();
    console.error(message);
  }

  /**
   * Print info on new line
   */
  info(message) {
    this.clearProgress();
    console.log(message);
  }

  /**
   * Clear current progress line
   */
  clearProgress() {
    this.stopAnimation();
    if (this.isProgress) {
      process.stdout.write('\r\x1b[K');
      this.isProgress = false;
      this.currentLine = '';
    }
  }

  /**
   * Just clear, no new line
   */
  clear() {
    this.stopAnimation();
    if (this.isProgress) {
      process.stdout.write('\r\x1b[K');
      this.isProgress = false;
      this.currentLine = '';
    }
  }
}

// Singleton instance
export const cliLogger = new CLILogger();
