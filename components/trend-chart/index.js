const chart = require('../../utils/chart');
const fmt = require('../../utils/format');

/**
 * 价格曲线组件（Canvas 2D）
 *
 * properties:
 *   points      [{ date, value }]
 *   mode        'step' | 'line'   step = 价格只在调价日变化（国内油价的正确画法）
 *   height      画布高度（px）
 *   showYAxis   是否显示左侧数值轴
 *   direction   'up' | 'down' | 'flat'  决定配色
 *   lineColor   自定义线条色（可选，覆盖 direction 配色）
 *   gridLines   横向网格线数量
 *   endDot      是否画末端圆点
 *   interactive 是否支持点选读数（点哪儿画哪儿，十字光标 + 读数气泡）
 *   unit        读数气泡里的单位（'' = 不显示）
 */
Component({
  properties: {
    points: { type: Array, value: [] },
    mode: { type: String, value: 'step' },
    height: { type: Number, value: 176 },
    showYAxis: { type: Boolean, value: false },
    direction: { type: String, value: 'flat' },
    lineColor: { type: String, value: '' },
    areaFrom: { type: String, value: '' },
    areaTo: { type: String, value: '' },
    dotColor: { type: String, value: '' },
    gridLines: { type: Number, value: 4 },
    endDot: { type: Boolean, value: true },
    // 弹层打开时置 false：画布是原生层，必须从 DOM 里摘掉才盖不住弹层
    visible: { type: Boolean, value: true },
    // 点选读数：点击/拖动画布画十字光标，报出那一格的日期与价格
    interactive: { type: Boolean, value: true },
    unit: { type: String, value: '' }
  },

  lifetimes: {
    ready() {
      this._frameId = null;
      this._canvas = null;
      this._layout = null;
      this._active = null;
      this.render();
    },
    detached() {
      // 组件销毁时把没执行的帧取消掉，别再往已销毁的画布上画
      if (this._frameId !== null && this._canvas && typeof this._canvas.cancelAnimationFrame === 'function') {
        this._canvas.cancelAnimationFrame(this._frameId);
      }
      this._frameId = null;
      this._canvas = null;
      this._layout = null;
      this._active = null;
    }
  },

  observers: {
    'points, mode, height, showYAxis, direction, lineColor, areaFrom, areaTo, dotColor, gridLines, endDot, visible, interactive, unit': function () {
      // 点集换了（切周期/切油品），之前选中的点就没意义了
      if (this._pointsRef !== this.data.points) {
        this._pointsRef = this.data.points;
        this._active = null;
      }
      this.render();
    }
  },

  methods: {
    render() {
      const query = this.createSelectorQuery();
      query.select('#chartCanvas').fields({ node: true, size: true, rect: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const dpr = (info && info.pixelRatio) || 2;
        const width = res[0].width;
        const height = res[0].height;
        if (!width || !height) return;

        const palette = chart.directionColors(this.data.direction);
        const options = {
          points: this.data.points || [],
          mode: this.data.mode,
          gridLines: this.data.gridLines,
          showYAxis: this.data.showYAxis,
          endDot: this.data.endDot,
          lineColor: this.data.lineColor || palette.lineColor,
          areaFrom: this.data.areaFrom || palette.areaFrom,
          areaTo: this.data.areaTo || palette.areaTo,
          dotColor: this.data.dotColor || chart.COLORS.point,
          yAxisFormat: (v) => v.toFixed(2)
        };

        // 选中的点 → 十字光标。
        // 几何用 computeLayout 算，和 drawSeries 内部用的是同一套
        // （同一份 options + 同一个画布尺寸），两边不会对不上。
        const layout = chart.computeLayout(options.points, options, width, height);
        this._layout = layout;
        this._rect = res[0];
        const idx = this._active;
        if (idx !== null && idx !== undefined && idx >= 0 && idx < options.points.length) {
          const point = options.points[idx];
          const tip = this._tipLines(point);
          options.crosshair = {
            x: layout.xs[idx],
            y: layout.yOf(Number(point.value)),
            valueText: tip[0],
            dateText: tip[1] || ''
          };
        }

        // 同一时刻只保留一个待绘制帧：observers 连续触发会排好几帧，
        // 多画几次既浪费也可能和 canvas 尺寸重设打架。
        if (this._frameId !== null && this._canvas && typeof this._canvas.cancelAnimationFrame === 'function') {
          this._canvas.cancelAnimationFrame(this._frameId);
        }
        this._canvas = canvas;

        const draw = function () {
          // 每次重绘都要重设尺寸（否则画布不会清干净），
          // 然后用 setTransform 设定缩放 —— 它是绝对设置，
          // scale 是累乘，重复渲染会把缩放变成 dpr 的 n 次方。
          canvas.width = width * dpr;
          canvas.height = height * dpr;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          chart.drawSeries(ctx, { width: width, height: height }, options);
        };

        if (typeof canvas.requestAnimationFrame === 'function') {
          this._frameId = canvas.requestAnimationFrame(function () {
            this._frameId = null;
            draw();
          }.bind(this));
        } else {
          draw();
        }
      });
    },

    /** 读数气泡的文字行（第一行价格，第二行日期） */
    _tipLines(point) {
      const value = fmt.price(point.value);
      const valueText = this.data.unit ? value + ' ' + this.data.unit : value;
      const dateText = this._dateText(point);
      // 小图（首页迷你走势只有 70px 高）塞不下两行，压成一行
      if (this.data.height < 100) {
        return dateText ? [dateText + '  ' + valueText] : [valueText];
      }
      return [valueText, dateText];
    },

    /** 读数气泡里的日期文案 */
    _dateText(point) {
      const s = String(point.date || '');
      // 油品历史是 YYYY-MM-DD、国际行情是 MM-DD HH:mm:ss
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return fmt.shortDate(s);
      return fmt.dateTime(s);
    },

    /** 取事件里最靠前的那个触点 */
    _touchOf(e) {
      const list = (e.touches && e.touches.length) ? e.touches : (e.changedTouches || []);
      return list && list.length ? list[0] : null;
    },

    /** 触点横坐标（相对画布） */
    _touchX(touch) {
      // canvas 2d 的触点自带相对画布的 x；拿不到时用 clientX 减画布左边距
      const x = Number(touch.x);
      if (isFinite(x)) return x;
      const clientX = Number(touch.clientX);
      if (isFinite(clientX) && this._rect && isFinite(this._rect.left)) {
        return clientX - this._rect.left;
      }
      return NaN;
    },

    /** 手指位置 → 最近的点的下标 */
    _pickIndex(touch) {
      const layout = this._layout;
      if (!layout) return -1;
      return chart.nearestIndex(layout.xs, this._touchX(touch));
    },

    _selectAt(touch, toggle) {
      const idx = this._pickIndex(touch);
      if (idx < 0) return;
      // 再点一次同一个点 = 收起读数（拖动时不收，否则会闪）
      if (toggle && this._active === idx) {
        this._active = null;
        this.render();
        return;
      }
      if (this._active === idx) return;   // 还是同一个点：不用重画
      this._active = idx;
      this.render();
    },

    onTouchStart(e) {
      if (!this.data.interactive) return;
      const t = this._touchOf(e);
      if (!t) return;
      this._selectAt(t, true);
    },

    onTouchMove(e) {
      if (!this.data.interactive) return;
      const t = this._touchOf(e);
      if (!t) return;
      this._selectAt(t, false);
    }
  }
});
