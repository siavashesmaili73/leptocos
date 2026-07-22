(function () {
  "use strict";

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const smoothstep = (min, max, value) => {
    const t = clamp((value - min) / Math.max(0.0001, max - min), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const mix = (from, to, amount) => from + (to - from) * amount;

  function seededRandom(seed) {
    return function random() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function rgba(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    return `rgba(${value >> 16},${(value >> 8) & 255},${value & 255},${alpha})`;
  }

  function nearestPaletteColor(red, green, blue, palette) {
    let best = palette[0];
    let bestDistance = Infinity;
    palette.forEach((hex) => {
      const value = parseInt(hex.slice(1), 16);
      const dr = red - (value >> 16);
      const dg = green - ((value >> 8) & 255);
      const db = blue - (value & 255);
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        best = hex;
        bestDistance = distance;
      }
    });
    return best;
  }

  function sampleImage(image, count, palette) {
    const sampleWidth = 720;
    const sampleHeight = Math.round(sampleWidth * image.naturalHeight / image.naturalWidth);
    const offscreen = document.createElement("canvas");
    offscreen.width = sampleWidth;
    offscreen.height = sampleHeight;
    const context = offscreen.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
    const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
    const candidates = [];

    for (let y = 1; y < sampleHeight - 1; y += 2) {
      for (let x = 1; x < sampleWidth - 1; x += 2) {
        const index = (y * sampleWidth + x) * 4;
        if (pixels[index + 3] < 62) continue;
        candidates.push({
          nx: x / sampleWidth,
          ny: y / sampleHeight,
          alpha: pixels[index + 3] / 255,
          color: nearestPaletteColor(pixels[index], pixels[index + 1], pixels[index + 2], palette),
        });
      }
    }

    const random = seededRandom(3224);
    candidates.forEach((candidate) => {
      candidate.priority = candidate.alpha * 0.72 + random() * 0.28;
    });
    candidates.sort((a, b) => b.priority - a.priority);

    const selected = [];
    const minDistance = count < 700 ? 0.0065 : 0.0045;
    const bins = Array.from({ length: 18 }, () => []);
    candidates.forEach((candidate) => bins[Math.min(17, Math.floor(candidate.ny * 18))].push(candidate));

    if (count >= 3000) {
      const denseSelection = [];
      const quota = Math.ceil(count / bins.length);
      bins.forEach((bin) => denseSelection.push(...bin.slice(0, quota)));
      if (denseSelection.length < count) {
        const chosen = new Set(denseSelection);
        for (let i = 0; i < candidates.length && denseSelection.length < count; i += 1) {
          if (!chosen.has(candidates[i])) denseSelection.push(candidates[i]);
        }
      }
      return denseSelection.slice(0, count);
    }

    let pass = 0;
    while (selected.length < count && pass < 5) {
      bins.forEach((bin) => {
        const quota = Math.ceil(count / bins.length);
        let used = selected.filter((point) => Math.floor(point.ny * 18) === bins.indexOf(bin)).length;
        for (let i = 0; i < bin.length && used < quota && selected.length < count; i += 1) {
          const candidate = bin[i];
          const spacing = minDistance * (1 - pass * 0.15);
          const clear = selected.every((point) => Math.hypot(
            (point.nx - candidate.nx) * 0.7,
            point.ny - candidate.ny
          ) > spacing);
          if (!clear) continue;
          selected.push(candidate);
          used += 1;
        }
      });
      pass += 1;
    }

    for (let i = 0; selected.length < count && i < candidates.length; i += 1) {
      if (!selected.includes(candidates[i])) selected.push(candidates[i]);
    }
    return selected.slice(0, count);
  }

  function buildDetailLayer(image, palette) {
    const source = document.createElement("canvas");
    source.width = image.naturalWidth;
    source.height = image.naturalHeight;
    const sourceContext = source.getContext("2d", { willReadFrequently: true });
    sourceContext.drawImage(image, 0, 0);
    const sourcePixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
    const detail = document.createElement("canvas");
    detail.width = source.width * 2;
    detail.height = source.height * 2;
    const detailContext = detail.getContext("2d");
    const detailImage = detailContext.createImageData(detail.width, detail.height);
    const detailPixels = detailImage.data;

    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const sourceIndex = (y * source.width + x) * 4;
        const alpha = sourcePixels[sourceIndex + 3];
        if (alpha < 28) continue;
        const hash = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0;
        if (hash % 10 > 7) continue;
        const color = nearestPaletteColor(
          sourcePixels[sourceIndex],
          sourcePixels[sourceIndex + 1],
          sourcePixels[sourceIndex + 2],
          palette
        );
        const value = parseInt(color.slice(1), 16);
        const detailX = x * 2 + (hash & 1);
        const detailY = y * 2 + ((hash >> 1) & 1);
        const detailIndex = (detailY * detail.width + detailX) * 4;
        detailPixels[detailIndex] = value >> 16;
        detailPixels[detailIndex + 1] = (value >> 8) & 255;
        detailPixels[detailIndex + 2] = value & 255;
        detailPixels[detailIndex + 3] = Math.min(210, 72 + Math.round(alpha * 0.54));
      }
    }
    detailContext.putImageData(detailImage, 0, 0);
    return detail;
  }

  function buildTargetEdges(targets) {
    if (targets.length > 1500) return [];
    const edgeKeys = new Set();
    const edges = [];
    targets.forEach((point, index) => {
      targets
        .map((other, otherIndex) => ({
          otherIndex,
          distance: Math.hypot((point.nx - other.nx) * 0.72, point.ny - other.ny),
        }))
        .filter((entry) => entry.otherIndex !== index)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3)
        .forEach((entry) => {
          if (entry.distance > 0.078) return;
          const a = Math.min(index, entry.otherIndex);
          const b = Math.max(index, entry.otherIndex);
          const key = `${a}:${b}`;
          if (edgeKeys.has(key)) return;
          edgeKeys.add(key);
          edges.push([a, b]);
        });
    });
    return edges;
  }

  window.LeptoScrollMorph = function LeptoScrollMorph(options) {
    const canvas = options.canvas;
    const hero = options.hero;
    const image = options.image;
    const palette = options.colors;
    const reducedMotion = options.reducedMotion;
    const context = canvas.getContext("2d");
    if (!context || !hero || !image) return false;

    const random = seededRandom(3224);
    const originalCanvasStyle = canvas.getAttribute("style") || "";
    const originalImageStyle = image.getAttribute("style") || "";
    const particles = [];
    let constellationParticles = [];
    let targetEdges = [];
    let width = 0;
    let height = 0;
    let dpr = 1;
    let targetsReady = false;
    let fixed = false;
    let frame = 0;
    let previousTime = 0;
    let targetMorph = 0;
    let morph = 0;
    let visibility = 1;
    let canvasBox = null;
    let imageBox = null;
    let detailLayer = null;

    hero.classList.add("is-scroll-morph");

    function captureBoxes() {
      const heroRect = hero.getBoundingClientRect();
      const imageRect = image.getBoundingClientRect();
      canvasBox = {
        left: heroRect.left,
        top: heroRect.top + scrollY,
        width: heroRect.width,
        height: heroRect.height,
      };
      imageBox = {
        left: imageRect.left,
        top: imageRect.top + scrollY,
        width: imageRect.width,
        height: imageRect.height,
      };
    }

    function setFixed(shouldFix) {
      if (fixed === shouldFix || !canvasBox || !imageBox) return;
      fixed = shouldFix;
      if (fixed) {
        Object.assign(canvas.style, {
          position: "fixed",
          inset: "auto",
          left: `${canvasBox.left}px`,
          top: `${canvasBox.top}px`,
          width: `${canvasBox.width}px`,
          height: `${canvasBox.height}px`,
          zIndex: "3",
        });
        Object.assign(image.style, {
          position: "fixed",
          inset: "auto",
          left: `${imageBox.left}px`,
          top: `${imageBox.top}px`,
          width: `${imageBox.width}px`,
          height: `${imageBox.height}px`,
          maxWidth: "none",
          zIndex: "3",
        });
      } else {
        canvas.setAttribute("style", originalCanvasStyle);
        image.setAttribute("style", originalImageStyle);
      }
    }

    function refreshProgress() {
      const heroTop = hero.getBoundingClientRect().top + scrollY;
      const localScroll = Math.max(0, scrollY - Math.max(0, heroTop - 58));
      const travel = 96;
      targetMorph = smoothstep(0, travel, localScroll);
      visibility = 1 - smoothstep(travel + 230, travel + 470, localScroll);
      setFixed(false);
    }

    function targetFrame() {
      const canvasRect = canvas.getBoundingClientRect();
      const imageRect = image.getBoundingClientRect();
      return {
        left: (fixed ? imageBox.left : imageRect.left) - (fixed ? canvasBox.left : canvasRect.left),
        top: (fixed ? imageBox.top : imageRect.top) - (fixed ? canvasBox.top : canvasRect.top),
        width: fixed ? imageBox.width : imageRect.width,
        height: fixed ? imageBox.height : imageRect.height,
      };
    }

    function createParticles(targets) {
      particles.length = 0;
      const anchorStride = Math.max(1, Math.floor(targets.length / (innerWidth < 760 ? 58 : 92)));
      targets.forEach((target, index) => {
        const depth = 0.38 + random() * 0.88;
        particles.push({
          x: random() * width,
          y: random() * height,
          vx: (random() - 0.5) * 10 * depth,
          vy: (random() - 0.5) * 8 * depth,
          radius: (0.36 + random() * 0.38) * (0.78 + depth * 0.22),
          phase: random() * Math.PI * 2,
          depth,
          color: target.color || palette[index % palette.length],
          target,
          anchor: index % anchorStride === 0,
          drawX: 0,
          drawY: 0,
        });
      });
      constellationParticles = particles.filter((particle) => particle.anchor);
      targetEdges = buildTargetEdges(targets);
      targetsReady = true;
    }

    function resize() {
      setFixed(false);
      captureBoxes();
      if (innerWidth < 760) {
        canvas.style.display = "none";
        image.style.display = "none";
        particles.length = 0;
        constellationParticles = [];
        targetEdges = [];
        targetsReady = true;
        refreshProgress();
        return;
      }
      canvas.style.display = "";
      image.style.display = "";
      dpr = Math.min(devicePixelRatio || 1, 2);
      width = Math.max(1, canvasBox.width);
      height = Math.max(1, canvasBox.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const targetCount = innerWidth < 760 ? 6000 : 20800;
      if (image.complete && image.naturalWidth) {
        if (!detailLayer) detailLayer = buildDetailLayer(image, palette);
        createParticles(sampleImage(image, targetCount, palette));
      }
      refreshProgress();
    }

    function drawFieldConnections(alpha, gather) {
      if (gather > 0.68) return;
      const limit = (innerWidth < 760 ? 78 : 128) * (1 - gather * 0.38);
      for (let i = 0; i < constellationParticles.length; i += 1) {
        const point = constellationParticles[i];
        for (let j = i + 1; j < constellationParticles.length; j += 1) {
          const other = constellationParticles[j];
          const distance = Math.hypot(point.drawX - other.drawX, point.drawY - other.drawY);
          if (distance >= limit) continue;
          context.globalAlpha = (1 - distance / limit) * alpha * (1 - gather * 0.88);
          context.strokeStyle = point.color;
          context.lineWidth = 0.38 + Math.min(point.depth, other.depth) * 0.32;
          context.beginPath();
          context.moveTo(point.drawX, point.drawY);
          context.lineTo(other.drawX, other.drawY);
          context.stroke();
        }
      }
    }

    function drawTargetConnections(alpha, formation) {
      const reveal = smoothstep(0.04, 0.92, formation);
      targetEdges.forEach(([aIndex, bIndex], edgeIndex) => {
        const a = particles[aIndex];
        const b = particles[bIndex];
        if (!a || !b) return;
        const pulse = 0.82 + Math.sin(edgeIndex * 0.73 + performance.now() * 0.0016) * 0.18;
        context.globalAlpha = reveal * alpha * 0.52 * pulse;
        context.strokeStyle = edgeIndex % 4 === 0 ? b.color : a.color;
        context.lineWidth = 0.42 + formation * 0.34;
        context.beginPath();
        context.moveTo(a.drawX, a.drawY);
        context.lineTo(b.drawX, b.drawY);
        context.stroke();
      });
    }

    function render(time) {
      const delta = Math.min(0.04, Math.max(0.001, (time - previousTime) / 1000 || 0.016));
      previousTime = time;
      morph = targetMorph;
      hero.dataset.morphProgress = morph.toFixed(3);
      context.clearRect(0, 0, width, height);
      if (!targetsReady) {
        frame = requestAnimationFrame(render);
        return;
      }

      const gather = smoothstep(0.015, 0.42, morph);
      const formation = smoothstep(0.34, 0.98, morph);
      const fieldAlpha = 0.125;
      const formedAlpha = 0.1;
      const pixelResolve = smoothstep(0.72, 0.995, formation);
      const alpha = mix(fieldAlpha, formedAlpha, smoothstep(0.08, 0.94, formation)) * (1 - pixelResolve * 0.7) * visibility;
      const timeSeconds = time / 1000;
      const targetBox = targetFrame();

      particles.forEach((particle, index) => {
        const drift = Math.sin(timeSeconds * 0.35 + particle.phase) * 0.26;
        particle.x += (particle.vx + drift) * delta;
        particle.y += (particle.vy - drift * 0.6) * delta;
        if (particle.x < -10 || particle.x > width + 10) particle.vx *= -1;
        if (particle.y < -10 || particle.y > height + 10) particle.vy *= -1;

        const target = {
          x: targetBox.left + particle.target.nx * targetBox.width,
          y: targetBox.top + particle.target.ny * targetBox.height,
        };
        const gatherX = width * (0.78 + (index % 7) * 0.018) + Math.sin(particle.phase) * 13;
        const gatherY = mix(particle.y, target.y, 0.76) + Math.cos(particle.phase) * 11;
        const stagger = clamp((formation - (index % 11) * 0.008) / 0.91, 0, 1);
        const formed = stagger * stagger * (3 - 2 * stagger);
        particle.drawX = mix(mix(particle.x, gatherX, gather), target.x, formed);
        particle.drawY = mix(mix(particle.y, gatherY, gather), target.y, formed);
        particle.drawX += Math.sin(timeSeconds * 0.48 + particle.phase) * 0.9 * formed;
        particle.drawY += Math.cos(timeSeconds * 0.42 + particle.phase) * 0.7 * formed;
      });

      context.save();
      context.globalCompositeOperation = "multiply";
      drawFieldConnections(fieldAlpha * (1 - gather * 0.82) * visibility, gather);
      drawTargetConnections(alpha, formation);
      context.restore();

      particles.forEach((particle, index) => {
        const detailWeight = 0.58 + particle.target.alpha * 0.54;
        const restingRadius = particle.radius * detailWeight;
        const constellationRadius = particle.anchor ? 0.9 + particle.depth * 0.38 : restingRadius * 0.32;
        const meshRadius = 0.18 + particle.target.alpha * 0.12;
        const radius = mix(constellationRadius, meshRadius, smoothstep(0.18, 0.96, formation));
        const glowRadius = radius * (4.2 + formation * 1.7);
        const pointAlpha = mix(particle.anchor ? fieldAlpha : 0.003, formedAlpha, smoothstep(0.05, 0.94, formation)) * (1 - pixelResolve * 0.7) * visibility;
        if ((particle.anchor && formation < 0.55) || index % 78 === 0) {
          const glow = context.createRadialGradient(
            particle.drawX,
            particle.drawY,
            0,
            particle.drawX,
            particle.drawY,
            glowRadius
          );
          glow.addColorStop(0, rgba(particle.color, 0.1 + formation * 0.12));
          glow.addColorStop(1, rgba(particle.color, 0));
          context.globalAlpha = pointAlpha * (0.56 + formation * 0.24);
          context.fillStyle = glow;
          context.beginPath();
          context.arc(particle.drawX, particle.drawY, glowRadius, 0, Math.PI * 2);
          context.fill();
        }
        context.globalAlpha = pointAlpha * (1.02 + formation * 0.72) * detailWeight;
        context.fillStyle = particle.color;
        context.beginPath();
        context.arc(particle.drawX, particle.drawY, radius, 0, Math.PI * 2);
        context.fill();
      });

      if (pixelResolve > 0) {
        context.save();
        context.imageSmoothingEnabled = false;
        context.globalAlpha = 0.34 * pixelResolve * visibility;
        context.drawImage(detailLayer || image, targetBox.left, targetBox.top, targetBox.width, targetBox.height);
        context.restore();
      }

      image.style.opacity = "0";
      const localScroll = Math.min(96, Math.max(0, scrollY - Math.max(0, hero.getBoundingClientRect().top + scrollY - 58)));
      const counterShift = localScroll * (innerWidth < 760 ? 0.9 : 0.7);
      const imageScale = mix(1, 0.86, morph);
      canvas.style.transform = `translate3d(0,${counterShift.toFixed(2)}px,0)`;
      image.style.transform = `translate3d(0,${counterShift.toFixed(2)}px,0) scale(${imageScale.toFixed(3)})`;
      canvas.style.opacity = visibility.toFixed(3);
      frame = requestAnimationFrame(render);
    }

    function reducedUpdate() {
      refreshProgress();
      image.style.opacity = "0";
      canvas.style.opacity = "0";
    }

    image.addEventListener("load", resize, { once: true });
    addEventListener("resize", resize, { passive: true });
    addEventListener("scroll", reducedMotion ? reducedUpdate : refreshProgress, { passive: true });
    resize();

    if (reducedMotion) {
      reducedUpdate();
    } else {
      frame = requestAnimationFrame(render);
    }

    window.LeptoScrollMorphState = {
      get progress() { return morph; },
      get target() { return targetMorph; },
      get fixed() { return fixed; },
      get particles() { return particles.length; },
      destroy() {
        cancelAnimationFrame(frame);
        setFixed(false);
        hero.classList.remove("is-scroll-morph");
      },
    };
    return true;
  };
})();
