/**
 * 底部弹层
 *
 * 用法：
 *   <bottom-sheet visible="{{sheetVisible}}" title="选择油价地区" bind:close="onSheetClose">
 *     ...内容...
 *   </bottom-sheet>
 */
Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '' },
    maskClosable: { type: Boolean, value: true }
  },

  methods: {
    // 阻止弹层内容滚动时背景跟着滚
    noop() {},
    onClose() {
      this.triggerEvent('close');
    },
    onMaskTap() {
      if (this.data.maskClosable) this.triggerEvent('close');
    }
  }
});
