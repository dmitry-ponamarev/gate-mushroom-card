/*
 * Gate Mushroom Card — карточка ворот в стиле Mushroom для Home Assistant.
 *
 * Типы ворот: откатные, секционные (подъёмные), распашные.
 * Управление: cover (open/stop/close), импульсный switch или button.
 * Статус: из cover, из датчика (binary_sensor/sensor) или локальная модель.
 * Иконка меняется по состоянию и настраивается для каждого состояния
 * через визуальный редактор (icon selector).
 */

const CARD_VERSION = "1.1.0";

const GATE_TYPES = ["sliding", "sectional", "swing"];

const DEFAULT_ICONS = {
  sliding: {
    closed: "mdi:gate",
    open: "mdi:gate-open",
    opening: "mdi:gate-arrow-right",
    closing: "mdi:gate-arrow-left",
    stopped: "mdi:gate-alert",
    unavailable: "mdi:alert-circle",
  },
  sectional: {
    closed: "mdi:garage",
    open: "mdi:garage-open",
    opening: "mdi:garage-open",
    closing: "mdi:garage",
    stopped: "mdi:garage-alert",
    unavailable: "mdi:alert-circle",
  },
  swing: {
    closed: "mdi:gate",
    open: "mdi:gate-open",
    opening: "mdi:gate-open",
    closing: "mdi:gate",
    stopped: "mdi:gate-alert",
    unavailable: "mdi:alert-circle",
  },
};

const STATE_TEXT = {
  closed: "Закрыто",
  open: "Открыто",
  opening: "Открывается…",
  closing: "Закрывается…",
  stopped: "Остановлено",
  unavailable: "Недоступно",
};

const STATE_COLOR = {
  closed: "var(--secondary-text-color)",
  open: "#43a047",
  opening: "#fb8c00",
  closing: "#fb8c00",
  stopped: "#fb8c00",
  unavailable: "#e53935",
};

const OPEN_WORDS = ["on", "open", "true", "home", "opened"];
const CLOSED_WORDS = ["off", "closed", "false", "not_home", "shut"];

class GateMushroomCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._ptrDown = false;
    this._needRender = false;
    this._lastSig = null;
    this._timer = null;
    // локальная модель для импульсного управления без датчика
    this._local = "closed";
    this._moving = null;      // {dir:'open'|'close', deadline:ms}
    this._stalled = null;     // {dir, baseAtStall} — стоп/нет подтверждения
    this._onPtrDown = () => { this._ptrDown = true; };
    this._onPtrUp = () => {
      this._ptrDown = false;
      if (this._needRender) {
        this._needRender = false;
        this._render(true);
      }
    };
  }

  connectedCallback() {
    this.addEventListener("pointerdown", this._onPtrDown, true);
    window.addEventListener("pointerup", this._onPtrUp);
    window.addEventListener("pointercancel", this._onPtrUp);
  }

  disconnectedCallback() {
    this.removeEventListener("pointerdown", this._onPtrDown, true);
    window.removeEventListener("pointerup", this._onPtrUp);
    window.removeEventListener("pointercancel", this._onPtrUp);
    if (this._timer) clearTimeout(this._timer);
  }

  static getStubConfig(hass) {
    const states = hass ? Object.values(hass.states) : [];
    const cover = states.find(
      (s) => s.entity_id.startsWith("cover.") &&
        ["gate", "garage"].includes(s.attributes.device_class)
    );
    if (cover) {
      return {
        entity: cover.entity_id,
        gate_type: cover.attributes.device_class === "garage" ? "sectional" : "sliding",
      };
    }
    const trig = states.find(
      (s) => s.entity_id.startsWith("switch.") && s.entity_id.endsWith("_trigger")
    );
    if (trig && hass) {
      const prefix = trig.entity_id.split(".")[1].replace(/_trigger$/, "");
      const contact = Object.keys(hass.states).find(
        (id) => id.startsWith("binary_sensor." + prefix) && id.includes("contact")
      );
      const cfg = { entity: trig.entity_id, gate_type: "sliding" };
      if (contact) cfg.status_entity = contact;
      return cfg;
    }
    return { entity: "cover.gate", gate_type: "sliding" };
  }

  static getConfigForm() {
    return {
      schema: [
        {
          name: "entity",
          required: true,
          selector: { entity: { filter: { domain: ["cover", "switch", "button"] } } },
        },
        {
          name: "status_entity",
          selector: { entity: { filter: { domain: ["binary_sensor", "sensor", "cover"] } } },
        },
        { name: "name", selector: { text: {} } },
        {
          name: "gate_type",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "sliding", label: "Откатные" },
                { value: "sectional", label: "Секционные (подъёмные)" },
                { value: "swing", label: "Распашные" },
              ],
            },
          },
        },
        {
          name: "layout",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "horizontal", label: "Горизонтальный" },
                { value: "vertical", label: "Вертикальный" },
              ],
            },
          },
        },
        { name: "invert_status", selector: { boolean: {} } },
        {
          name: "move_timeout",
          selector: {
            number: { min: 5, max: 300, step: 1, mode: "box", unit_of_measurement: "с" },
          },
        },
        {
          name: "icons_group",
          type: "expandable",
          title: "Иконки по состояниям",
          schema: [
            { name: "icon", selector: { icon: {} } },
            { name: "icon_closed", selector: { icon: {} } },
            { name: "icon_open", selector: { icon: {} } },
            { name: "icon_opening", selector: { icon: {} } },
            { name: "icon_closing", selector: { icon: {} } },
            { name: "icon_stopped", selector: { icon: {} } },
            { name: "icon_unavailable", selector: { icon: {} } },
          ],
        },
      ],
      computeLabel: (schema) =>
        ({
          entity: "Сущность управления (cover / switch / button)",
          status_entity: "Датчик состояния (необязательно)",
          name: "Название",
          gate_type: "Тип ворот",
          layout: "Вид карточки",
          invert_status: "Инвертировать датчик (on = закрыто)",
          move_timeout: "Таймаут движения",
          icon: "Иконка (одна для всех состояний)",
          icon_closed: "Иконка: закрыто",
          icon_open: "Иконка: открыто",
          icon_opening: "Иконка: открывается",
          icon_closing: "Иконка: закрывается",
          icon_stopped: "Иконка: остановлено",
          icon_unavailable: "Иконка: недоступно",
        }[schema.name] || schema.name),
      computeHelper: (schema) =>
        ({
          status_entity:
            "Контакт opening/closed: binary_sensor (on = открыто) или cover. Без датчика состояние оценивается по таймауту.",
          move_timeout:
            "Сколько ждать подтверждения от датчика после импульса. По истечении — «Остановлено». Для cover не используется.",
          invert_status: "Если датчик сообщает on = закрыто (обратная логика контакта).",
        }[schema.name] || undefined),
    };
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("Укажите entity — сущность управления воротами (cover / switch / button)");
    }
    const dom = config.entity.split(".")[0];
    if (!["cover", "switch", "button"].includes(dom)) {
      throw new Error("entity должна быть cover.*, switch.* или button.*");
    }
    this._config = config;
    this._type = GATE_TYPES.includes(config.gate_type) ? config.gate_type : "sliding";
    this._layout = config.layout === "vertical" ? "vertical" : "horizontal";
    this._timeout = Math.max(5, Number(config.move_timeout) || 30) * 1000;
    this._local = "closed";
    this._moving = null;
    this._stalled = null;
    this._lastSig = null;
    this._render(true);
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 1;
  }

  _state(id) {
    return id && this._hass ? this._hass.states[id] : undefined;
  }

  _call(domain, service, data) {
    if (this._hass) this._hass.callService(domain, service, data);
  }

  _isUnavail(st) {
    return !st || st.state === "unavailable" || st.state === "unknown";
  }

  // базовое (подтверждённое) состояние: open | closed | opening | closing | unavailable
  _baseState() {
    const cfg = this._config;
    const ctrl = this._state(cfg.entity);
    const status = cfg.status_entity ? this._state(cfg.status_entity) : null;

    // button.* всегда в unknown до первого нажатия — это не «недоступно»
    const ctrlUnavail =
      !ctrl ||
      ctrl.state === "unavailable" ||
      (ctrl.state === "unknown" && !cfg.entity.startsWith("button."));
    if (ctrlUnavail) return "unavailable";

    if (cfg.status_entity) {
      if (this._isUnavail(status)) return "unavailable";
      const sDom = cfg.status_entity.split(".")[0];
      if (sDom === "cover") {
        return ["open", "closed", "opening", "closing"].includes(status.state)
          ? status.state
          : "unavailable";
      }
      const raw = String(status.state).toLowerCase();
      let open;
      if (OPEN_WORDS.includes(raw)) open = true;
      else if (CLOSED_WORDS.includes(raw)) open = false;
      else return "unavailable";
      if (cfg.invert_status) open = !open;
      return open ? "open" : "closed";
    }

    if (cfg.entity.startsWith("cover.")) {
      return ["open", "closed", "opening", "closing"].includes(ctrl.state)
        ? ctrl.state
        : "unavailable";
    }

    return this._local; // импульс без датчика — локальная модель
  }

  _hasSensor() {
    return !!this._config.status_entity;
  }

  // итоговое состояние с учётом движения/остановки
  _deriveState() {
    const base = this._baseState();
    if (base === "unavailable") {
      this._moving = null;
      return base;
    }
    // cover сам сообщает opening/closing — локальная модель не нужна
    if (base === "opening" || base === "closing") {
      this._moving = null;
      this._stalled = null;
      return base;
    }

    if (this._moving) {
      const target = this._moving.dir === "open" ? "open" : "closed";
      if (base === target) {
        // датчик (или модель) подтвердил конечное положение
        this._moving = null;
        this._local = base;
        return base;
      }
      if (Date.now() > this._moving.deadline) {
        const dir = this._moving.dir;
        this._moving = null;
        if (this._hasSensor()) {
          this._stalled = { dir, baseAtStall: base };
          return "stopped";
        }
        this._local = target; // без датчика считаем, что доехало
        return target;
      }
      return this._moving.dir === "open" ? "opening" : "closing";
    }

    if (this._stalled) {
      if (base !== this._stalled.baseAtStall) {
        this._stalled = null; // датчик изменился — ситуация разрешилась
      } else {
        return "stopped";
      }
    }

    this._local = base;
    return base;
  }

  _position() {
    const cfg = this._config;
    const src = cfg.status_entity && cfg.status_entity.startsWith("cover.")
      ? this._state(cfg.status_entity)
      : cfg.entity.startsWith("cover.")
      ? this._state(cfg.entity)
      : null;
    const p = src && src.attributes ? src.attributes.current_position : undefined;
    return typeof p === "number" ? p : null;
  }

  _resolveIcon(stateKey) {
    const cfg = this._config;
    return (
      cfg["icon_" + stateKey] ||
      cfg.icon ||
      DEFAULT_ICONS[this._type][stateKey] ||
      DEFAULT_ICONS.sliding[stateKey]
    );
  }

  _armTimer(ms) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._render(true), ms + 60);
  }

  _pulse() {
    const dom = this._config.entity.split(".")[0];
    if (dom === "button") this._call("button", "press", { entity_id: this._config.entity });
    else if (dom === "switch") this._call("switch", "toggle", { entity_id: this._config.entity });
  }

  _act() {
    const st = this._deriveState();
    if (st === "unavailable") return;
    const cfg = this._config;

    if (cfg.entity.startsWith("cover.")) {
      if (st === "opening" || st === "closing") {
        this._call("cover", "stop_cover", { entity_id: cfg.entity });
      } else {
        const pos = this._position();
        const wantClose = st === "open" && (pos === null || pos >= 50);
        this._call("cover", wantClose ? "close_cover" : "open_cover", { entity_id: cfg.entity });
      }
      this._render(true);
      return;
    }

    // импульсное управление
    if (st === "opening" || st === "closing") {
      // импульс во время движения = стоп
      const dir = st === "opening" ? "open" : "close";
      this._moving = null;
      this._stalled = { dir, baseAtStall: this._baseState() };
      this._pulse();
      this._render(true);
      return;
    }

    let dir;
    if (st === "stopped") {
      dir = (this._stalled && this._stalled.dir) || "open";
    } else {
      dir = st === "open" ? "close" : "open";
    }
    this._stalled = null;
    this._moving = { dir, deadline: Date.now() + this._timeout };
    this._pulse();
    this._armTimer(this._timeout);
    this._render(true);
  }

  _render(force) {
    if (!this._config || !this._hass || !this.shadowRoot) return;
    if (this._ptrDown && !force) {
      this._needRender = true;
      return;
    }

    const cfg = this._config;
    const ctrl = this._state(cfg.entity);
    const st = this._deriveState();
    const pos = this._position();
    const moving = st === "opening" || st === "closing";

    const name =
      cfg.name ||
      (ctrl && ctrl.attributes.friendly_name) ||
      "Ворота";

    let label;
    if (st === "unavailable") label = "—";
    else if (moving) label = "Стоп";
    else if (st === "stopped") label = "Продолжить";
    else if (cfg.entity.startsWith("cover.") && pos !== null && pos > 0 && pos < 100) {
      label = pos >= 50 ? "Закрыть" : "Открыть";
    } else label = st === "open" ? "Закрыть" : "Открыть";

    const icon = this._resolveIcon(st);
    const color = STATE_COLOR[st] || STATE_COLOR.closed;
    const stateText =
      STATE_TEXT[st] + (pos !== null && st !== "unavailable" ? ` · ${Math.round(pos)}%` : "");

    const sig = [name, st, stateText, icon, label, color, moving, this._layout].join("|");
    if (!force && sig === this._lastSig) return;
    this._lastSig = sig;

    const bg =
      st === "closed"
        ? "color-mix(in srgb, var(--secondary-text-color) 15%, transparent)"
        : `color-mix(in srgb, ${color} 18%, transparent)`;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          border-radius: 12px;
          padding: 12px 14px;
          overflow: visible;
        }
        .row { display: flex; align-items: center; gap: 12px; min-height: 46px; }
        .shape {
          width: 42px; height: 42px; border-radius: 50%; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
          background: ${bg};
          transition: background .3s;
        }
        .shape ha-icon {
          --mdc-icon-size: 22px;
          color: ${color};
          transition: color .3s;
        }
        .shape.moving ha-icon { animation: pulse 1.1s ease-in-out infinite; }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: .45; transform: scale(.88); }
        }
        .names { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .primary {
          font-size: 14px; font-weight: 500; color: var(--primary-text-color);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .secondary {
          font-size: 12px; color: var(--secondary-text-color); margin-top: 2px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .secondary b { color: ${color}; font-weight: 600; }
        .pill {
          appearance: none; border: none; cursor: pointer; flex-shrink: 0;
          height: 32px; padding: 0 14px; border-radius: 16px;
          font-size: 12.5px; font-weight: 600; font-family: inherit;
          color: ${st === "closed" || st === "unavailable" ? "var(--primary-text-color)" : color};
          background: ${
            st === "closed" || st === "unavailable"
              ? "color-mix(in srgb, var(--primary-text-color) 7%, transparent)"
              : `color-mix(in srgb, ${color} 16%, transparent)`
          };
          transition: background .15s, transform .05s;
        }
        .pill:hover { filter: brightness(.95); }
        .pill:active { transform: scale(.96); }
        .pill:disabled { opacity: .4; cursor: default; transform: none; }
        .unavail { opacity: .6; }
        /* ---- вертикальный вид (как в Mushroom) ---- */
        ha-card.vertical { display: flex; flex-direction: column; }
        ha-card.vertical .v-top { margin-bottom: 8px; }
        ha-card.vertical .names { margin-bottom: 12px; }
        ha-card.vertical .pill { align-self: stretch; }
      </style>
      <ha-card class="${[st === "unavailable" ? "unavail" : "", this._layout === "vertical" ? "vertical" : ""].join(" ").trim()}">
        ${this._layout === "vertical" ? `
        <div class="v-top">
          <div class="shape${moving ? " moving" : ""}"><ha-icon icon="${icon}"></ha-icon></div>
        </div>
        <div class="names">
          <span class="primary">${name}</span>
          <span class="secondary"><b>${STATE_TEXT[st]}</b>${
            pos !== null && st !== "unavailable" ? ` · ${Math.round(pos)}%` : ""
          }</span>
        </div>
        <button class="pill" id="act" ${st === "unavailable" ? "disabled" : ""}>${label}</button>
        ` : `
        <div class="row">
          <div class="shape${moving ? " moving" : ""}"><ha-icon icon="${icon}"></ha-icon></div>
          <div class="names">
            <span class="primary">${name}</span>
            <span class="secondary"><b>${STATE_TEXT[st]}</b>${
              pos !== null && st !== "unavailable" ? ` · ${Math.round(pos)}%` : ""
            }</span>
          </div>
          <button class="pill" id="act" ${st === "unavailable" ? "disabled" : ""}>${label}</button>
        </div>
        `}
      </ha-card>
    `;

    this.shadowRoot.querySelector("#act").addEventListener("click", () => this._act());
  }
}

customElements.define("gate-mushroom-card", GateMushroomCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "gate-mushroom-card",
  name: "Gate Mushroom Card",
  description:
    "Ворота в стиле Mushroom: откатные, секционные, распашные. Статус иконкой и текстом, импульсное или cover-управление, настраиваемые иконки.",
  preview: false,
});

console.info(
  `%cGATE-MUSHROOM-CARD%c v${CARD_VERSION}`,
  "color:#43a047;font-weight:bold",
  "color:inherit"
);
