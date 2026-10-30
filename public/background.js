const vertexShaderSource = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  uniform sampler2D uImage;
  uniform vec2 uResolution;
  uniform vec2 uImageResolution;
  uniform float uDpr;
  uniform float uTime;
  uniform float uPhase;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  vec2 coverUv(vec2 uv) {
    float viewAspect = uResolution.x / uResolution.y;
    float imageAspect = uImageResolution.x / uImageResolution.y;
    if (viewAspect < imageAspect) {
      uv.x = (uv.x - 0.5) * (viewAspect / imageAspect) + 0.5;
    } else {
      uv.y = (uv.y - 0.5) * (imageAspect / viewAspect) + 0.5;
    }
    return uv;
  }

  void main() {
    float animationTime = uTime * 3.0;
    // Shrink each independently drifting particle cell from 8px to about 3px
    // so the same flowing field reads as finer-grained rather than chunky.
    float cellSize = 3.2 * uDpr;
    vec2 cell = floor(gl_FragCoord.xy / cellSize);
    vec2 local = fract(gl_FragCoord.xy / cellSize);
    float edge = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
    float softParticle = smoothstep(0.0, 0.45, edge);

    vec2 cellCenter = (cell + 0.5) * cellSize / uResolution;
    vec3 sourceColor = texture2D(uImage, coverUv(cellCenter)).rgb;
    float sunlit = smoothstep(0.38, 0.66, sourceColor.r)
      * smoothstep(0.4, 0.68, sourceColor.g)
      * (1.0 - smoothstep(0.2, 0.47, sourceColor.b));
    float forest = smoothstep(0.015, 0.15, sourceColor.g - sourceColor.r)
      * smoothstep(0.02, 0.17, sourceColor.g - sourceColor.b);
    float cool = smoothstep(0.025, 0.16, sourceColor.b - sourceColor.g)
      * smoothstep(0.2, 0.44, sourceColor.b);
    float colorWeight = clamp(max(sunlit, max(forest, cool * 0.65)), 0.0, 1.0);

    float seed = hash(cell + vec2(uPhase, 19.7));
    float seed2 = hash(cell + vec2(43.7, 91.3));
    float phaseX = animationTime * (0.045 + seed * 0.19) + seed * 6.28318;
    float phaseY = animationTime * (0.04 + seed2 * 0.22) + seed2 * 6.28318;
    vec2 particleDirection = normalize(vec2(
      cos(phaseX) + 0.42 * sin(phaseY * 0.57 + seed * 8.0),
      sin(phaseY) + 0.42 * cos(phaseX * 0.63 + seed2 * 8.0)
    ));
    float particlePixels = (22.0 + 42.0 * hash(cell + 7.31)) * colorWeight * softParticle;

    vec2 broadFlowPixels = vec2(
      sin(vUv.y * 6.0 + animationTime * 0.09 + uPhase) * 29.0,
      cos(vUv.x * 5.2 - animationTime * 0.075 + uPhase) * 25.0
    );
    vec2 displacement = (broadFlowPixels + particleDirection * particlePixels * uDpr) / uResolution;
    // Keep every displaced sample inside the image's clean interior so the
    // source image's edge pixels can never appear as a seam at the viewport.
    vec2 imageUv = clamp(coverUv(vUv + displacement), vec2(0.10), vec2(0.90));
    vec4 color = texture2D(uImage, imageUv);

    float glowWave = 0.5 + 0.5 * sin(vUv.x * 7.0 - vUv.y * 3.4 + animationTime * 0.16 + uPhase);
    float glow = glowWave * (sunlit * 0.75 + forest * 0.55 + cool * 0.2);
    float particleGlow = (0.5 + 0.5 * sin(animationTime * 0.12 + seed * 6.28318))
      * colorWeight * smoothstep(0.38, 1.0, softParticle);
    color.rgb *= 1.0 + glow * 0.065 + particleGlow * 0.025;
    gl_FragColor = color;
  }
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || "Background shader compilation failed");
  }
  return shader;
}

function createRenderer(canvas, phase) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  let program;
  let texture;
  try {
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Background shader linking failed");
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1, 1, 1,
    ]), gl.STATIC_DRAW);
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const uniforms = {
      image: gl.getUniformLocation(program, "uImage"),
      resolution: gl.getUniformLocation(program, "uResolution"),
      imageResolution: gl.getUniformLocation(program, "uImageResolution"),
      dpr: gl.getUniformLocation(program, "uDpr"),
      time: gl.getUniformLocation(program, "uTime"),
      phase: gl.getUniformLocation(program, "uPhase"),
    };
    gl.uniform1i(uniforms.image, 0);
    gl.uniform1f(uniforms.phase, phase);

    const image = new Image();
    image.onload = () => {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.uniform2f(uniforms.imageResolution, image.naturalWidth, image.naturalHeight);
      canvas.dataset.ready = "true";
      render(0);
    };
    image.onerror = () => console.warn("Sound-Map background image could not be loaded");
    image.src = "/assets/nature-flow.jpg";

    function render(time) {
      if (!canvas.width || !canvas.height) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.dpr, Math.min(window.devicePixelRatio || 1, 1.25));
      gl.uniform1f(uniforms.time, time);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      return dpr;
    }

    const resizeObserver = new ResizeObserver(() => {
      resize();
      render(0);
    });
    resizeObserver.observe(canvas);
    resize();
    return { canvas, render, gl };
  } catch (error) {
    console.warn("Sound-Map particle background is unavailable; using the still image.", error);
    if (program) gl.deleteProgram(program);
    if (texture) gl.deleteTexture(texture);
    return null;
  }
}

const mobileLayout = window.matchMedia("(max-width: 1099px)");
const mobileSharedCanvas = document.querySelector(".mobile-ambient-background");

const renderers = (mobileLayout.matches
  ? [mobileSharedCanvas].filter(Boolean)
  : [...document.querySelectorAll(".landscape-particles")]
).map((canvas, index) => createRenderer(canvas, mobileLayout.matches ? 0 : index * 2.17))
  .filter(Boolean);

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let frameId = 0;
let lastFrame = 0;

function drawFrame(now) {
  frameId = 0;
  if (document.hidden) return;
  if (now - lastFrame >= 1000 / 30) {
    const time = now * 0.001;
    for (const renderer of renderers) {
      const screen = renderer.canvas.closest(".app-screen");
      if (screen && getComputedStyle(screen).display === "none") continue;
      renderer.render(time);
    }
    lastFrame = now;
  }
  if (!reducedMotion.matches) frameId = requestAnimationFrame(drawFrame);
}

function startAnimation() {
  if (reducedMotion.matches) {
    for (const renderer of renderers) renderer.render(0);
    return;
  }
  if (!document.hidden && !frameId) frameId = requestAnimationFrame(drawFrame);
}

function stopAnimation() {
  if (frameId) cancelAnimationFrame(frameId);
  frameId = 0;
}

reducedMotion.addEventListener("change", () => {
  stopAnimation();
  startAnimation();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopAnimation();
  else startAnimation();
});
startAnimation();
