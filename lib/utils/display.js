const proggy = require('proggy')
const { log } = require('proc-log')
const { explain } = require('./explain-eresolve.js')
const { formatWithOptions } = require('./format')

const COLOR_PALETTE = ({ chalk: c }) => ({
  heading: c.white.bgBlack,
  title: c.magenta,
  timing: c.green.bgBlack,
  // loglevels
  error: c.red.bgBlack,
  warn: c.black.bgYellow,
  notice: c.blue.bgBlack,
  http: c.green.bgBlack,
  info: c.green,
  verbose: c.blue.bgBlack,
  silly: c.inverse,
})

const LEVELS = log.LEVELS.reduce((acc, key) => {
  acc[key] = key
  return acc
}, {})

const LEVEL_OPTIONS = {
  silent: {
    index: 0,
  },
  error: {
    index: 1,
    label: 'ERR!',
  },
  warn: {
    index: 2,
    label: 'WARN',
  },
  notice: {
    index: 3,
  },
  http: {
    index: 4,
  },
  info: {
    index: 5,
  },
  verbose: {
    index: 6,
    label: 'verb',
  },
  silly: {
    index: 7,
    label: 'sill',
  },
}

const LEVEL_METHODS = {
  ...LEVEL_OPTIONS,
  [LEVELS.timing]: {
    show: ({ timing, index }) => !!timing && index !== 0,
  },
}

const safeJsonParse = (maybeJsonStr) => {
  if (typeof maybeJsonStr !== 'string') {
    return maybeJsonStr
  }
  try {
    return JSON.parse(maybeJsonStr)
  } catch {
    return {}
  }
}

const setBlocking = (stream) => {
  // Copied from https://github.com/yargs/set-blocking
  // https://raw.githubusercontent.com/yargs/set-blocking/master/LICENSE.txt
  /* istanbul ignore next - we trust that this works */
  if (stream._handle && stream.isTTY && typeof stream._handle.setBlocking === 'function') {
    stream._handle.setBlocking(true)
  }
  return stream
}

const getLevel = (stringOrLevelObject) => {
  if (typeof stringOrLevelObject === 'string') {
    return { level: stringOrLevelObject }
  }
  return stringOrLevelObject
}

class Display {
  #logState = {
    buffering: true,
    buffer: [],
  }

  #outputState = {
    buffering: true,
    buffer: [],
  }

  // colors
  #stdoutChalk
  #stdoutColor
  #stderrChalk
  #stderrColor
  #logColors

  // progress
  #progress

  // options
  #levelIndex
  #timing
  #json
  #heading

  // display streams
  #stdout
  #stderr

  constructor ({ stdout, stderr }) {
    this.#stdout = setBlocking(stdout)
    this.#stderr = setBlocking(stderr)
    // Handlers are set immediately so they can buffer all events
    process.on('log', this.#logHandler)
    process.on('output', this.#outputHandler)
  }

  off () {
    process.off('log', this.#logHandler)
    this.#logState.buffer.length = 0

    process.off('output', this.#outputHandler)
    this.#outputState.buffer.length = 0

    if (this.#progress) {
      this.#progress.stop()
    }
  }

  load ({
    loglevel,
    stdoutColor,
    stdoutChalk,
    stderrColor,
    stderrChalk,
    timing,
    unicode,
    progress,
    json,
    heading,
  }) {
    this.#stdoutColor = stdoutColor
    this.#stdoutChalk = stdoutChalk

    this.#stderrColor = stderrColor
    this.#stderrChalk = stderrChalk

    this.#logColors = COLOR_PALETTE({ chalk: stderrChalk })

    this.#levelIndex = LEVEL_OPTIONS[loglevel].index
    this.#timing = timing
    this.#json = json
    this.#heading = heading

    // In silent mode we remove all the handlers
    if (this.#levelIndex <= 0) {
      this.off()
      return
    }

    // Emit resume event on the logs which will flush output
    log.resume()

    // TODO: this should be a proc-log method `proc-log.output.flush`?
    this.#outputHandler('flush')

    this.#startProgress({ progress, unicode })
  }

  // Public class field so it can be passed directly as a listener
  #logHandler = (...args) => {
    if (args[0] === LEVELS.resume) {
      this.#logState.buffering = false
      this.#logState.buffer.forEach((item) => this.#tryWriteLog(...item))
      this.#logState.buffer.length = 0
      return
    }

    if (args[0] === LEVELS.pause) {
      this.#logState.buffering = true
      return
    }

    if (this.#logState.buffering) {
      this.#logState.buffer.push(args)
      return
    }

    this.#tryWriteLog(...args)
  }

  // Public class field so it can be passed directly as a listener
  #outputHandler = (...args) => {
    if (args[0] === 'flush') {
      this.#outputState.buffering = false
      if (args[1] && this.#json) {
        const mergedJsonOutput = {}
        for (const [, ...items] of this.#outputState.buffer) {
          Object.assign(mergedJsonOutput, ...items.map(safeJsonParse))
        }
        Object.assign(args[1])
        this.#writeOutput('standard', JSON.stringify(mergedJsonOutput, null, 2))
      } else {
        this.#outputState.buffer.forEach((item) => this.#writeOutput(...item))
      }
      this.#outputState.buffer.length = 0
      return
    }

    if (args[0] === 'buffer') {
      this.#outputState.buffer.push(['standard', ...args.slice(1)])
      return
    }

    if (this.#outputState.buffering) {
      this.#outputState.buffer.push(args)
      return
    }

    this.#writeOutput(...args)
  }

  // OUTPUT

  #writeOutput (...args) {
    const { level } = getLevel(args.shift())

    if (level === 'standard') {
      this.#stdout.write(formatWithOptions({ colors: this.#stdoutColor }, ...args))
      return
    }

    if (level === 'error') {
      this.#stderr.write(formatWithOptions({ colors: this.#stderrColor }, ...args))
    }
  }

  // TODO: move this to proc-log and remove this public method
  flushOutput (jsonError) {
    this.#outputHandler('flush', jsonError)
  }

  // LOGS

  forceLog (level, ...args) {
    // This will show the log regardless of the current loglevel
    if (this.#levelIndex !== 0) {
      this.#logHandler({ level, force: true }, ...args)
    }
  }

  #tryWriteLog (...args) {
    try {
      // Also (and this is a really inexcusable kludge), we patch the
      // log.warn() method so that when we see a peerDep override
      // explanation from Arborist, we can replace the object with a
      // highly abbreviated explanation of what's being overridden.
      // TODO: this could probably be moved to arborist now that display is refactored
      const [level, heading, message, expl] = args
      if (level === LEVELS.warn && heading === 'ERESOLVE' && expl && typeof expl === 'object') {
        this.#writeLog(level, heading, message)
        this.#writeLog(level, '', explain(expl, this.#stderrChalk, 2))
        return
      }
      this.#writeLog(...args)
    } catch (ex) {
      try {
        // if it crashed once, it might again!
        this.#writeLog(LEVELS.verbose, null, `attempt to log crashed`, ...args, ex)
      } catch (ex2) {
        /* istanbul ignore next - this happens if the object has an inspect method that crashes */
        // eslint-disable-next-line no-console
        console.error(`attempt to log crashed`, ex, ex2)
      }
    }
  }

  #writeLog (...args) {
    const { level, force = false } = getLevel(args.shift())

    const levelOpts = LEVEL_METHODS[level]
    const show = levelOpts.show ?? (({ index }) => levelOpts.index <= index)

    if (force || show({ index: this.#levelIndex, timing: this.#timing })) {
      // this mutates the array so we can pass args directly to format later
      const title = args.shift()
      const prefix = [
        this.#logColors.heading(this.#heading),
        this.#logColors[level](levelOpts.label ?? level),
        title ? this.#logColors.title(title) : null,
      ]
      this.#stderr.write(formatWithOptions({ prefix, colors: this.stderrColor }, ...args))
    } else if (this.#progress) {
      // TODO: make this display a single log line of filtered messages
    }
  }

  // PROGRESS

  #startProgress ({ progress, unicode }) {
    if (!progress) {
      return
    }
    this.#progress = proggy.createClient({ normalize: true })
    // TODO: implement proggy trackers in arborist/doctor
    // TODO: listen to progress events here and build progress UI
    // TODO: see deprecated gauge package for what unicode chars were used
  }
}

module.exports = Display
