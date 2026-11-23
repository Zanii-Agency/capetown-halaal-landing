/**
 * PIXL - Visual Drag & Drop Editor
 * By Lord / Zanii
 *
 * Auto-activates on localhost when DevTools opens
 * Cmd+Shift+E to toggle
 */

(function() {
  'use strict';

  // =====================
  // PIXL STATE
  // =====================
  const PIXL = {
    active: false,
    selectedElement: null,
    isDragging: false,
    isResizing: false,
    dragStart: { x: 0, y: 0 },
    elementStart: { x: 0, y: 0, width: 0, height: 0 },
    changes: {},
    history: [],
    historyIndex: -1
  };

  // =====================
  // RESPONSIVE CALCULATOR
  // =====================
  const ResponsiveCalc = {
    // Convert px to relative units
    toRelative(px, containerSize, viewportSize) {
      return {
        percent: (px / containerSize * 100).toFixed(2) + '%',
        vw: (px / viewportSize * 100).toFixed(2) + 'vw',
        px: Math.round(px) + 'px'
      };
    },

    // Calculate clamp value for responsive sizing
    toClamp(minPx, currentPx, maxPx) {
      const minVw = (minPx / 375 * 100).toFixed(2);
      const maxVw = (maxPx / 1440 * 100).toFixed(2);
      return `clamp(${minPx}px, ${minVw}vw, ${maxPx}px)`;
    },

    // Get element position relative to parent
    getRelativePosition(element) {
      const rect = element.getBoundingClientRect();
      const parent = element.offsetParent || document.body;
      const parentRect = parent.getBoundingClientRect();

      return {
        top: ((rect.top - parentRect.top) / parentRect.height * 100).toFixed(2),
        left: ((rect.left - parentRect.left) / parentRect.width * 100).toFixed(2),
        width: (rect.width / parentRect.width * 100).toFixed(2),
        height: (rect.height / parentRect.height * 100).toFixed(2)
      };
    },

    // Generate responsive CSS
    generateCSS(element, position, size) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      return {
        position: 'absolute',
        top: position.top + '%',
        left: position.left + '%',
        width: this.toClamp(size.width * 0.8, size.width, size.width * 1.2),
        transform: 'translate(-50%, -50%)'
      };
    }
  };

  // =====================
  // UI PANEL
  // =====================
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'pixl-panel';
    panel.innerHTML = `
      <div class="pixl-header">
        <div class="pixl-logo">
          <span class="pixl-icon">◆</span>
          <span>PIXL</span>
        </div>
        <div class="pixl-controls">
          <button id="pixl-undo" title="Undo (Cmd+Z)">↶</button>
          <button id="pixl-redo" title="Redo (Cmd+Shift+Z)">↷</button>
          <button id="pixl-close" title="Close (Esc)">✕</button>
        </div>
      </div>

      <div class="pixl-body">
        <div class="pixl-section">
          <div class="pixl-label">SELECTED</div>
          <div id="pixl-selected" class="pixl-value">None</div>
        </div>

        <div class="pixl-section">
          <div class="pixl-label">POSITION</div>
          <div class="pixl-grid">
            <div class="pixl-input-group">
              <label>X</label>
              <input type="number" id="pixl-x" value="0">
              <span>%</span>
            </div>
            <div class="pixl-input-group">
              <label>Y</label>
              <input type="number" id="pixl-y" value="0">
              <span>%</span>
            </div>
          </div>
        </div>

        <div class="pixl-section">
          <div class="pixl-label">SIZE</div>
          <div class="pixl-grid">
            <div class="pixl-input-group">
              <label>W</label>
              <input type="number" id="pixl-w" value="0">
              <span>px</span>
            </div>
            <div class="pixl-input-group">
              <label>H</label>
              <input type="number" id="pixl-h" value="0">
              <span>px</span>
            </div>
          </div>
        </div>

        <div class="pixl-section">
          <div class="pixl-label">SCALE</div>
          <input type="range" id="pixl-scale" min="50" max="200" value="100">
          <div id="pixl-scale-value" class="pixl-value">100%</div>
        </div>

        <div class="pixl-section">
          <div class="pixl-label">DEVICE PREVIEW</div>
          <div class="pixl-devices">
            <button class="pixl-device" data-width="375">SE</button>
            <button class="pixl-device active" data-width="390">14</button>
            <button class="pixl-device" data-width="430">Max</button>
            <button class="pixl-device" data-width="768">Tablet</button>
          </div>
        </div>
      </div>

      <div class="pixl-footer">
        <button id="pixl-copy" class="pixl-btn secondary">COPY JSON</button>
        <button id="pixl-save" class="pixl-btn primary">SAVE</button>
      </div>

      <div id="pixl-toast" class="pixl-toast"></div>
    `;

    document.body.appendChild(panel);
    return panel;
  }

  // =====================
  // SELECTION OVERLAY
  // =====================
  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'pixl-overlay';
    overlay.innerHTML = `
      <div class="pixl-selection-box">
        <div class="pixl-handle nw" data-handle="nw"></div>
        <div class="pixl-handle n" data-handle="n"></div>
        <div class="pixl-handle ne" data-handle="ne"></div>
        <div class="pixl-handle w" data-handle="w"></div>
        <div class="pixl-handle e" data-handle="e"></div>
        <div class="pixl-handle sw" data-handle="sw"></div>
        <div class="pixl-handle s" data-handle="s"></div>
        <div class="pixl-handle se" data-handle="se"></div>
      </div>
      <div class="pixl-label-box"></div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  // =====================
  // ELEMENT SELECTION
  // =====================
  function selectElement(element) {
    if (!element || element.id === 'pixl-panel' || element.closest('#pixl-panel') || element.closest('#pixl-overlay')) {
      return;
    }

    PIXL.selectedElement = element;
    element.classList.add('pixl-selected');

    updateOverlay();
    updatePanel();
  }

  function deselectElement() {
    if (PIXL.selectedElement) {
      PIXL.selectedElement.classList.remove('pixl-selected');
      PIXL.selectedElement = null;
    }

    const overlay = document.getElementById('pixl-overlay');
    if (overlay) {
      overlay.style.display = 'none';
    }

    document.getElementById('pixl-selected').textContent = 'None';
  }

  function updateOverlay() {
    const element = PIXL.selectedElement;
    if (!element) return;

    const overlay = document.getElementById('pixl-overlay');
    const box = overlay.querySelector('.pixl-selection-box');
    const label = overlay.querySelector('.pixl-label-box');
    const rect = element.getBoundingClientRect();

    overlay.style.display = 'block';

    box.style.top = rect.top + 'px';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';

    // Element label
    const tagName = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const className = element.className ? `.${element.className.split(' ')[0]}` : '';
    label.textContent = `${tagName}${id}${className}`;
    label.style.top = (rect.top - 24) + 'px';
    label.style.left = rect.left + 'px';
  }

  function updatePanel() {
    const element = PIXL.selectedElement;
    if (!element) return;

    const pos = ResponsiveCalc.getRelativePosition(element);
    const rect = element.getBoundingClientRect();

    document.getElementById('pixl-selected').textContent = element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '');
    document.getElementById('pixl-x').value = Math.round(parseFloat(pos.left));
    document.getElementById('pixl-y').value = Math.round(parseFloat(pos.top));
    document.getElementById('pixl-w').value = Math.round(rect.width);
    document.getElementById('pixl-h').value = Math.round(rect.height);
  }

  // =====================
  // DRAG & DROP
  // =====================
  function startDrag(e) {
    if (!PIXL.selectedElement || !PIXL.active) return;

    const handle = e.target.dataset?.handle;

    if (handle) {
      PIXL.isResizing = true;
      PIXL.resizeHandle = handle;
    } else if (e.target.closest('.pixl-selection-box')) {
      PIXL.isDragging = true;
    } else {
      return;
    }

    const rect = PIXL.selectedElement.getBoundingClientRect();
    PIXL.dragStart = { x: e.clientX, y: e.clientY };
    PIXL.elementStart = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    };

    e.preventDefault();
  }

  function doDrag(e) {
    if (!PIXL.isDragging && !PIXL.isResizing) return;

    const dx = e.clientX - PIXL.dragStart.x;
    const dy = e.clientY - PIXL.dragStart.y;
    const element = PIXL.selectedElement;

    if (PIXL.isDragging) {
      // Get current transform or compute from position
      const style = window.getComputedStyle(element);
      const matrix = new DOMMatrix(style.transform);

      element.style.transform = `translate(${matrix.e + dx}px, ${matrix.f + dy}px)`;
      PIXL.dragStart = { x: e.clientX, y: e.clientY };
    }

    if (PIXL.isResizing) {
      const handle = PIXL.resizeHandle;
      let newWidth = PIXL.elementStart.width;
      let newHeight = PIXL.elementStart.height;

      if (handle.includes('e')) newWidth += dx;
      if (handle.includes('w')) newWidth -= dx;
      if (handle.includes('s')) newHeight += dy;
      if (handle.includes('n')) newHeight -= dy;

      element.style.width = Math.max(20, newWidth) + 'px';
      element.style.height = Math.max(20, newHeight) + 'px';
    }

    updateOverlay();
    updatePanel();
    saveChange();
  }

  function endDrag() {
    if (PIXL.isDragging || PIXL.isResizing) {
      addToHistory();
    }
    PIXL.isDragging = false;
    PIXL.isResizing = false;
    PIXL.resizeHandle = null;
  }

  // =====================
  // HISTORY (UNDO/REDO)
  // =====================
  function addToHistory() {
    if (!PIXL.selectedElement) return;

    const state = {
      element: PIXL.selectedElement,
      styles: PIXL.selectedElement.getAttribute('style') || ''
    };

    // Remove any redo states
    PIXL.history = PIXL.history.slice(0, PIXL.historyIndex + 1);
    PIXL.history.push(state);
    PIXL.historyIndex = PIXL.history.length - 1;
  }

  function undo() {
    if (PIXL.historyIndex <= 0) return;
    PIXL.historyIndex--;
    applyHistory();
  }

  function redo() {
    if (PIXL.historyIndex >= PIXL.history.length - 1) return;
    PIXL.historyIndex++;
    applyHistory();
  }

  function applyHistory() {
    const state = PIXL.history[PIXL.historyIndex];
    if (state && state.element) {
      state.element.setAttribute('style', state.styles);
      selectElement(state.element);
    }
  }

  // =====================
  // SAVE & EXPORT
  // =====================
  function saveChange() {
    if (!PIXL.selectedElement) return;

    const element = PIXL.selectedElement;
    const pos = ResponsiveCalc.getRelativePosition(element);
    const rect = element.getBoundingClientRect();
    const id = element.id || element.className.split(' ')[0] || element.tagName.toLowerCase();

    PIXL.changes[id] = {
      selector: element.id ? `#${element.id}` : `.${element.className.split(' ')[0]}`,
      position: {
        top: pos.top + '%',
        left: pos.left + '%'
      },
      size: {
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      responsive: {
        mobile: ResponsiveCalc.toClamp(rect.width * 0.7, rect.width, rect.width),
        tablet: ResponsiveCalc.toClamp(rect.width * 0.85, rect.width * 1.1, rect.width * 1.2),
        desktop: ResponsiveCalc.toClamp(rect.width, rect.width * 1.2, rect.width * 1.5)
      },
      transform: element.style.transform || 'none',
      timestamp: Date.now()
    };
  }

  function copyJSON() {
    const json = JSON.stringify(PIXL.changes, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      showToast('Copied to clipboard!');
    });
  }

  function saveAll() {
    const json = JSON.stringify(PIXL.changes, null, 2);

    // Save to localStorage for persistence
    localStorage.setItem('pixl-changes', json);

    // Copy to clipboard for Claude
    navigator.clipboard.writeText(json).then(() => {
      showToast('Saved! Paste to Claude to apply.');
      console.log('%c=== PIXL EXPORT ===', 'color: #cd2653; font-weight: bold; font-size: 14px;');
      console.log(json);
      console.log('%c==================', 'color: #cd2653; font-weight: bold;');
    });
  }

  function showToast(message) {
    const toast = document.getElementById('pixl-toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }

  // =====================
  // EVENT HANDLERS
  // =====================
  function handleClick(e) {
    if (!PIXL.active) return;
    if (e.target.closest('#pixl-panel') || e.target.closest('#pixl-overlay')) return;

    e.preventDefault();
    e.stopPropagation();

    deselectElement();
    selectElement(e.target);
  }

  function handleKeydown(e) {
    // Toggle Pixl: Cmd+Shift+E
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'e') {
      e.preventDefault();
      togglePixl();
      return;
    }

    if (!PIXL.active) return;

    // Escape: Close/Deselect
    if (e.key === 'Escape') {
      if (PIXL.selectedElement) {
        deselectElement();
      } else {
        togglePixl();
      }
      return;
    }

    // Undo: Cmd+Z
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }

    // Redo: Cmd+Shift+Z
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'z') {
      e.preventDefault();
      redo();
      return;
    }

    // Arrow keys: Move element
    if (PIXL.selectedElement && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const element = PIXL.selectedElement;
      const style = window.getComputedStyle(element);
      const matrix = new DOMMatrix(style.transform);

      let dx = 0, dy = 0;
      if (e.key === 'ArrowUp') dy = -step;
      if (e.key === 'ArrowDown') dy = step;
      if (e.key === 'ArrowLeft') dx = -step;
      if (e.key === 'ArrowRight') dx = step;

      element.style.transform = `translate(${matrix.e + dx}px, ${matrix.f + dy}px)`;
      updateOverlay();
      updatePanel();
      saveChange();
    }
  }

  // =====================
  // INIT & TOGGLE
  // =====================
  function togglePixl() {
    PIXL.active = !PIXL.active;

    const panel = document.getElementById('pixl-panel');
    const overlay = document.getElementById('pixl-overlay');

    if (PIXL.active) {
      panel.classList.add('active');
      document.body.classList.add('pixl-active');
      showToast('Pixl activated');
    } else {
      panel.classList.remove('active');
      overlay.style.display = 'none';
      document.body.classList.remove('pixl-active');
      deselectElement();
    }
  }

  function init() {
    // Only run on localhost
    if (!window.location.hostname.includes('localhost') && !window.location.hostname.includes('127.0.0.1')) {
      return;
    }

    // Create UI
    createPanel();
    createOverlay();

    // Bind events
    document.addEventListener('click', handleClick, true);
    document.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', doDrag);
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('keydown', handleKeydown);

    // Panel button events
    document.getElementById('pixl-close').addEventListener('click', togglePixl);
    document.getElementById('pixl-undo').addEventListener('click', undo);
    document.getElementById('pixl-redo').addEventListener('click', redo);
    document.getElementById('pixl-copy').addEventListener('click', copyJSON);
    document.getElementById('pixl-save').addEventListener('click', saveAll);

    // Scale slider
    document.getElementById('pixl-scale').addEventListener('input', (e) => {
      const scale = e.target.value;
      document.getElementById('pixl-scale-value').textContent = scale + '%';
      if (PIXL.selectedElement) {
        PIXL.selectedElement.style.transform = `scale(${scale / 100})`;
        updateOverlay();
        saveChange();
      }
    });

    // Device preview buttons
    document.querySelectorAll('.pixl-device').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pixl-device').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Could implement viewport resize preview here
        showToast(`Preview: ${btn.dataset.width}px`);
      });
    });

    // Input fields
    ['pixl-x', 'pixl-y', 'pixl-w', 'pixl-h'].forEach(id => {
      document.getElementById(id).addEventListener('change', (e) => {
        if (!PIXL.selectedElement) return;
        const value = parseInt(e.target.value);
        const element = PIXL.selectedElement;

        if (id === 'pixl-w') element.style.width = value + 'px';
        if (id === 'pixl-h') element.style.height = value + 'px';
        // X/Y would need transform adjustment

        updateOverlay();
        saveChange();
      });
    });

    // Load saved changes
    const saved = localStorage.getItem('pixl-changes');
    if (saved) {
      PIXL.changes = JSON.parse(saved);
    }

    // Auto-activate on localhost
    setTimeout(() => {
      togglePixl();
    }, 500);

    console.log('%c◆ PIXL Active', 'color: #cd2653; font-weight: bold; font-size: 16px;');
    console.log('%cCmd+Shift+E to toggle', 'color: #888;');
  }

  // Start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
