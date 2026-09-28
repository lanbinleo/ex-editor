import { Notice, Plugin } from 'obsidian';

export default class ExEditorPlugin extends Plugin {
	async onload() {
		this.addCommand({
			id: 'smoke-test',
			name: '冒烟测试：确认插件已加载',
			callback: () => {
				new Notice('插件已就绪');
			},
		});
	}

	onunload() {
		// M0 骨架阶段尚无全局资源需要清理。
	}
}
