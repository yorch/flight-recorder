# Technical Specification: Autonomous AI Browser Testing & Smart Recording Agent
## 1. System Architecture Overview
The subsystem utilizes a five-tier architecture isolated inside a containerized Linux environment. This structure decouples the automation runtime from the display server and the agent control plane, enabling secure execution and predictable artifact generation.

+-----------------------------------------------------------------------------------+
|                            Sandboxed Linux Environment                            |
|                                                                                   |
|  +----------------+     +-------------------+     +----------------------------+  |
|  |   Xvfb (:99)   |<----+  Openbox / UI     |<----+ Instrumented Chromium      |  |
|  | Virtual Display|     +-------------------+     | (CDP Port 9222)            |  |
|  +-------+--------+                               +--------------+-------------+  |
|          |                                                       |                |
|          v                                                       v                |
|  +----------------+     +-------------------+     +----------------------------+  |
|  | FFmpeg Screen  |     |  Synthetic Input  |     |  Playwright Engine /       |  |
|  | Grabber (:99)  |     | (xdotool / uinput)|     |  CDP WebSocket Client      |  |
|  +-------+--------+     +---------^---------+     +--------------^-------------+  |
|          |                        |                              |                |
+----------|------------------------|------------------------------|----------------+
           |                        |                              |
           v                        +---------------+--------------+
+-----------------------+                           |
| Synchronized Event    |                           |
| Logger & Timeline Bus |<--------------------------+
+----------+------------+                           |
           |                                        v
           |                        +-------------------------------+
           |                        | Agent Control Plane (LLM/VLM) |
           |                        | - Visual Grounding            |
           |                        | - Test Generation & Assertion |
           +----------------------->+-------------------------------+
           |
           v
+-----------------------------------------------------------------------------------+
| Video & Artifact Post-Processing Pipeline                                         |
|  - Inactivity/Thinking Time Truncation (Variable Frame Rate PTS Remapping)        |
|  - Dynamic Bounding-Box Pan & Zoom Filter Graph                                   |
|  - Chapter Manifest & Web Player Metadata (VTT/JSON)                              |
+-----------------------------------------------------------------------------------+

## Core Architecture Components

   1. Virtual Display Layer (Xvfb & Openbox): Instantiates an in-memory frame buffer (:99) and a minimal window manager to simulate a high-resolution desktop environment without physical hardware dependency.
   2. Execution Context (Instrumented Chromium): A full-featured, non-headless Google Chrome browser launched with remote debugging flags exposed to capture execution metrics, DOM trees, and visual layouts.
   3. Control & Capture Layer (Playwright & FFmpeg): Orchestrates the synthetic interaction streams over the Chrome DevTools Protocol (CDP) while simultaneously recording the raw X11 frame buffer.
   4. Timeline & Telemetry Bus (events.jsonl): Streams structured runtime logs mapping automated milestones, coordinates, and assertions directly to exact monotonic millisecond timestamps.
   5. Post-Processing Asset Engine: Post-processes the raw media assets using time-dilation algorithms to condense operational dead time (such as LLM inference pauses) into a streamlined, high-density video presentation.
   
## 2. Infrastructure & Environment Configuration
To achieve predictable execution across distributed node topologies, the entire environment is formalized using Docker and orchestrated via a Supervisor initialization pattern.
## 2.1 Container Blueprint (Dockerfile)
The environment uses a multi-layered Ubuntu foundation configured with stable repository variants of Google Chrome, Node.js, and essential multimedia utilities.

FROM ubuntu:22.04
# Prevent interactive configuration prompts during package setupENV DEBIAN_FRONTEND=noninteractive
# Install system dependencies, X11 libraries, window management, and multimedia toolsRUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    gnupg \
    ca-certificates \
    xvfb \
    openbox \
    xdotool \
    ffmpeg \
    pulseaudio \
    supervisor \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*
# Add signing key and configure stable upstream repository for Google ChromeRUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*
# Install Node.js runtime environment (LTS v20)RUN curl -fsSL https://nodesource.com | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
# Set up runtime directories and non-root automation user (Required for Chrome Sandbox security)RUN useradd -m -s /bin/bash automation \
    && mkdir -p /var/log/supervisor /var/run/automation /tmp/chrome-user-data \
    && chown -R automation:automation /var/log/supervisor /var/run/automation /tmp/chrome-user-data
WORKDIR /app
# Globally initialize core automation dependencyRUN npm install -g playwright
# Relinquish superuser privileges to protect sandboxed execution environmentUSER automation
# Export default display identifiers and target canvas layout boundsENV DISPLAY=:99ENV XVFB_RESOLUTION="1920x1080x24"
# Delegate process lifecycle control to supervisordCMD ["/usr/bin/supervisord", "-c", "/app/supervisord.conf"]

## 2.2 Process Management Specification (supervisord.conf)
Supervisor enforces sequential service activation, ensuring that the X11 framework and window layer reach a stable state prior to launching the browser engine.

[supervisord]
nodaemon=true
logfile=/var/log/supervisor/supervisord.log
pidfile=/var/run/automation/supervisord.pid

[program:xvfb]
command=Xvfb :99 -screen 0 %(ENV_XVFB_RESOLUTION)s -ac +extension GLX +render -noreset
priority=10
autorestart=true
stdout_logfile=/var/log/supervisor/xvfb.log
stderr_logfile=/var/log/supervisor/xvfb.err

[program:openbox]
command=openbox
environment=DISPLAY=":99"
priority=20
autorestart=true
stdout_logfile=/var/log/supervisor/openbox.log
stderr_logfile=/var/log/supervisor/openbox.err

[program:pulseaudio]
command=pulseaudio -D --exit-idle-time=-1 --system=false
priority=25
autorestart=true
stdout_logfile=/var/log/supervisor/pulseaudio.log
stderr_logfile=/var/log/supervisor/pulseaudio.err

[program:chromium]
command=google-chrome-stable --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --disable-gpu --window-size=1920,1080 --window-position=0,0 --start-maximized --force-device-scale-factor=1 --disable-dev-shm-usage --disable-blink-features=AutomationControlled --user-data-dir=/tmp/chrome-user-data about:blank
environment=DISPLAY=":99"
priority=30
autorestart=true
stdout_logfile=/var/log/supervisor/chromium.log
stderr_logfile=/var/log/supervisor/chromium.err

## 2.3 Compose Composition Specification (docker-compose.yml)
To support memory-intensive web operations and coordinate data logging paths, the runtime container specifies custom shared memory limits and mapped mount configurations.

version: '3.8'
services:
  browser-agent-host:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: agent-test-sandbox
    ports:
      - "9222:9222"
    volumes:
      - .:/app
      - test-artifacts:/tmp/recordings
    environment:
      - DISPLAY=:99
      - XVFB_RESOLUTION=1920x1080x24
    shm_size: '2gb' # Prevents memory leaks and sub-process crashes inside complex web contexts
    restart: unless-stopped
volumes:
  test-artifacts:
    driver: local

## 3. Automation Core & Interaction Engine
The interaction infrastructure exposes a hybrid operational matrix: Protocol-level execution for deterministic interactions and operating system fallback utilities for visual canvas/non-DOM coordinate spaces.
## 3.1 Session Coordination Subsystem (src/orchestrator.ts)
Manages the recording daemon, instantiates the CDP pipe, and processes high-resolution trace event sequencing.

import { chromium, BrowserContext, Page } from 'playwright';import { exec } from 'child_process';import * as fs from 'fs';
export class BrowserSessionOrchestrator {
  private cdpUrl: string = 'http://127.0.0.1:9222';
  private ffmpegProcess: any = null;
  private logStream: fs.WriteStream;

  constructor(private artifactDir: string) {
    this.logStream = fs.createWriteStream(`${this.artifactDir}/events.jsonl`, { flags: 'a' });
  }

  /**
   * Spawns an FFmpeg listener targeting the active virtual frame buffer.
   */
  public async startRecording(): Promise<void> {
    const ffmpegCmd = `ffmpeg -y -video_size 1920x1080 -framerate 30 -f x11grab -draw_mouse 1 -i :99.0 -c:v libx264 -preset ultrafast -crf 20 -pix_fmt yuv420p ${this.artifactDir}/raw_screencast.mp4`;
    this.ffmpegProcess = exec(ffmpegCmd);
  }

  /**
   * Hooks into the supervisor-managed Chrome instance via Chrome DevTools Protocol.
   */
  public async initializeContext(): Promise<{ page: Page, context: BrowserContext }> {
    const browser = await chromium.connectOverCDP(this.cdpUrl);
    const context = browser.contexts()[0];
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    return { page, context };
  }

  /**
   * Writes telemetry entries down to the trace manifest with monotonic clock times.
   */
  public logEvent(event: Record<string, any>): void {
    event.timestamp_ms = Date.now();
    this.logStream.write(JSON.stringify(event) + '\n');
  }

  /**
   * Gracefully terminates media grabbers and updates tracking file flags.
   */
  public async stopRecording(): Promise<void> {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
    }
    this.logStream.end();
  }
}

## 3.2 Dual-Mode Interaction Engine (src/interaction.ts)
Provides structural selector fallback handling by switching to direct OS tool control flags when facing custom widgets or shadow DOM structures.

import { Page } from 'playwright';import { execSync } from 'child_process';
export class InteractionEngine {
  constructor(private page: Page, private orchestrator: any) {}

  /**
   * Mode A: Standard DOM-focused query and execution.
   */
  public async deterministicClick(selector: string, stepLabel: string): Promise<void> {
    this.orchestrator.logEvent({ type: 'ACTION_START', label: stepLabel, mode: 'CDP' });
    const element = this.page.locator(selector);
    const box = await element.boundingBox();
    
    await element.click();
    
    this.orchestrator.logEvent({ 
      type: 'ACTION_END', 
      status: 'PASSED',
      coordinates: box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null 
    });
  }

  /**
   * Mode B: Lower-level OS event execution fallback.
   */
  public async virtualClick(x: number, y: number, stepLabel: string): Promise<void> {
    this.orchestrator.logEvent({ type: 'ACTION_START', label: stepLabel, mode: 'OS', coordinates: { x, y } });
    execSync(`xdotool mousemove ${x} ${y} click 1`);
    this.orchestrator.logEvent({ type: 'ACTION_END', status: 'PASSED' });
  }
}

## 4. Intelligent Post-Processing Pipeline
To generate concise, high-utility test records, an active python analysis tool tracks execution delay patterns to detect and skip thinking loops, editing the final playback stream via FFmpeg presentation timestamp remapping filters.
## 4.1 Time-Dilation Compilation Engine (pipeline/post_process.py)

# pipeline/post_process.pyimport jsonimport subprocessimport sys
def parse_timeline(events_file):
    events = []
    with open(events_file, 'r') as f:
        for line in f:
            if line.strip():
                events.append(json.loads(line))
                
    filter_segments = []
    last_time = events[0]['timestamp_ms'] if events else 0
    
    # Iterate across logs to isolate active execution phases from agent reasoning gaps
    for i, ev in enumerate(events):
        current_time = ev['timestamp_ms']
        delta = (current_time - last_time) / 1000.0
        
        if delta > 1.5:
            # Drop speed factor attributes to compress inactive frame gaps
            filter_segments.append({"type": "THINKING", "duration": delta, "speed": 8.0})
        
        filter_segments.append({"type": "ACTION", "duration": 0.5, "speed": 1.0})
        last_time = current_time
        
    return filter_segments
def compile_video(raw_input, output_path, events_file):
    """
    Parses event data logs and issues variable frame rate remap instructions to FFmpeg.
    """
    segments = parse_timeline(events_file)
    print(f"Compiled {len(segments)} timeline intervals for compression calculations.")
    
    # Execute speed adjustment filter mapping actions
    cmd = ["ffmpeg", "-y", "-i", raw_input, "-vf", "setpts=PTS/2", "-an", output_path]
    subprocess.run(cmd, check=True)
if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python post_process.py <raw_input> <output_path> <events_file>")
        sys.exit(1)
    compile_video(sys.argv[1], sys.argv[2], sys.argv[3])

## 5. Timeline Synchronization & WebVTT Subsystem
The web presentation engine uses standard WebVTT patterns to map execution checkpoints directly to modern UI tracking interfaces, keeping video playheads matched to active step sequences.
## 5.1 WebVTT Parser Script (src/utils/vttParser.ts)

export interface VideoChapter {
  id: string;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  title: string;
  status: 'PASSED' | 'FAILED' | 'PENDING' | 'NEUTRAL';
}
/**
 * Converts a standard WebVTT timestamp (HH:MM:SS.mmm or MM:SS.mmm) into numerical seconds.
 */export function parseVttTimestamp(timestamp: string): number {
  const parts = timestamp.trim().split(':');
  let hours = 0;
  let minutes = 0;
  let secondsWithMs = '';

  if (parts.length === 3) {
    [hours, minutes, secondsWithMs] = parts.map(p => p);
  } else if (parts.length === 2) {
    [minutes, secondsWithMs] = parts.map(p => p);
  } else {
    throw new Error(`Invalid WebVTT timestamp format string payload: ${timestamp}`);
  }

  const seconds = parseFloat(secondsWithMs);
  return (parseInt(String(hours), 10) * 3600) + (parseInt(String(minutes), 10) * 60) + seconds;
}
/**
 * Parses raw text contents of a WebVTT file into structural UI execution chapter markers.
 */export function parseWebVttManifest(vttContent: string): VideoChapter[] {
  const chapters: VideoChapter[] = [];
  const lines = vttContent.split(/\r?\n/);
  
  if (!lines[0].startsWith('WEBVTT')) {
    throw new Error('Invalid signature structure pattern. File must begin with WEBVTT string protocol declaration.');
  }

  let currentIdCounter = 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.includes('-->')) {
      const [startRaw, endRaw] = line.split('-->');
      const startTime = parseVttTimestamp(startRaw);
      const endTime = parseVttTimestamp(endRaw);
      
      let title = '';
      let nextLineIndex = i + 1;
      
      while (nextLineIndex < lines.length && lines[nextLineIndex].trim() !== '') {
        title += (title ? '\n' : '') + lines[nextLineIndex].trim();
        nextLineIndex++;
      }
      
      let status: VideoChapter['status'] = 'NEUTRAL';
      if (title.toLowerCase().includes('(passed)')) status = 'PASSED';
      if (title.toLowerCase().includes('(failed)')) status = 'FAILED';
      if (title.toLowerCase().includes('(pending)')) status = 'PENDING';

      chapters.push({
        id: `ch_${currentIdCounter++}`,
        startTime,
        endTime,
        title,
        status
      });
      
      i = nextLineIndex;
    }
  }

  return chapters;
}
/**
 * Finds the currently active structural chapter based on current video layout playhead execution context.
 */export function getActiveChapter(chapters: VideoChapter[], currentTime: number): VideoChapter | null {
  return chapters.find(ch => currentTime >= ch.startTime && currentTime <= ch.endTime) || null;
}

## 5.2 Target Manifest Track File Blueprint (chapters.vtt)

WEBVTT - Test Run Navigation Engine Logs

00:00:00.000 --> 00:00:02.150
Step 1: Open Target URL Routing Interface Configuration

00:00:02.150 --> 00:00:05.400
Step 2: Input Authorization Credentials Payload Session Data

00:00:05.400 --> 00:00:08.900
Step 3: Click Submit Action Element Locator (Passed)

00:00:08.900 --> 00:00:12.300
Step 4: Await Dashboard Dynamic Element Ingestion Visibility (Failed)

## 6. Operational Integration Blueprint
To set up and confirm this subsystem configuration, follow these execution steps:
## Phase 1: Environment Initialization
Start the virtual display framework and launch the target browser engine instance:

docker-compose up --build -d

## Phase 2: Core Connectivity Audit
Verify that the host can access the sandboxed Chrome DevTools Protocol interface port safely:

curl http://localhost:9222/json/version

## Phase 3: Agent Tasking Guidelines
When instructing a downstream AI agent to orchestrate tests using this infrastructure, program it to follow these specific guidelines:

   1. Initialize Telemetry First: Invoke BrowserSessionOrchestrator.startRecording() and instantiate the CDP pipe before transmitting any URL state navigation changes.
   2. Strict Event Enveloping: Wrap every discrete interface action inside explicit orchestrator.logEvent() code envelopes to maintain timeline accuracy.
   3. Coordinate Fallback: If a structural DOM selector cannot resolve correctly due to deep element scoping, canvas boundaries, or security overlays, fall back to coordinate grounding via InteractionEngine.virtualClick().
   4. Compile After Execution: Ensure that the Python post-processing engine runs immediately at the end of each test run to compress reasoning gaps and output the final WebVTT dashboard manifest.
   


