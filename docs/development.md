# 开发与正式发布

源码位于workspace，构建和测试中间文件在work，交付文件在outputs，均有忽略规则。请使用Windows x64、Node.js 24及Python 3.13。

```powershell
npm ci --prefix workspace
python scripts/bootstrap-build.py
workspace\.venv\Scripts\python.exe workspace\build-desktop.py
node workspace/build-desktop.cjs
python workspace/package-desktop.py
```

测试：在workspace执行 `node --test *.test.cjs`，以及 `python -B v100-update-helper.test.py`。需先创建work/tests。界面与EXE还需检查启动进度、自检、配置保留及打包路径。

## 发布新版

仓库已配置 `CELLSTATION_UPDATE_SIGNING_KEY` Actions Secret，签名公钥在workspace/release-config.json。私钥不进入源码和发布包。公钥必须长期稳定，不能随意重新生成，否则旧客户端无法验证更新。

在GitHub Actions中选择“Build and publish release”，点击Run workflow，输入高于当前版本的版本号，例如1.0.3。工作流会修改版本标识、测试、构建公开无数据包、签名清单、上传Release，再更新main分支的update/latest.json。工作流不会上传本地账号或执行记录。

也可本地构建后用 `node workspace/sign-release.cjs 输出ZIP 清单JSON 私钥PEM` 签名，先发布对应Release资产，再更新update/latest.json。

自动更新顺序：检查签名清单→国内下载加速/直连回退→验证大小和SHA256→等待预约空闲→外部Python进程替换程序文件→新程序本地自检与主界面加载→确认健康并删除旧程序备份。失败时恢复旧程序与更新前配置，不删除用户data目录。

若部署自有国内镜像，把签名latest.json原样镜像到HTTPS地址，在程序设置中填写；下载源默认使用ghfast.top加速GitHub Release，失败回退GitHub。不得把AzurPilot项目的专用更新接口替换进来。

参考：[GitHub Actions Python文档](https://docs.github.com/en/actions/tutorials/build-and-test-code/python)、[AzurPilot更新实现](https://github.com/wess09/AzurPilot/blob/master/deploy/git.py)。


## CNB 国内 Git 更新

仓库：https://cnb.cool/mreasento/CellStation 。GitHub的main保存开发源码；独立app-stable分支只保存应用代码、界面和逐文件SHA256清单，标签app-v<版本>固定一次发布。Python、OCR、Electron和MinGit不进入该分支。

签名清单仍包含完整ZIP的兼容入口，另签入gitRevision、gitRef、gitRuntimeId和gitManifestSha256。旧客户端继续使用完整包；新客户端运行环境指纹匹配时使用内置Git匿名拉取固定标签，核对提交和清单，再由独立更新器校验每个文件。应用更新不覆盖runtime或data，不删除未列入旧应用清单的文件；启动失败恢复应用及配置。环境指纹不一致或增量源不可用则使用完整包。

GitHub Actions Secret CNB_SYNC_TOKEN仅授权本仓库代码读写，不进入客户端。sync-cnb.yml同步手动推送的main、app-stable及版本标签。正式发布工作流还会显式同步CNB，避免GITHUB_TOKEN推送不触发后续Actions的限制。先确认Git分支及版本资产存在，再发布签名清单。

本地发布：构建完整包后运行python -B scripts/publish-app.py <程序目录>，再给sign-release.cjs追加私钥文件及work/app-update-v<版本>.json参数。CI使用--env-key从Secret读取签名密钥。所有凭据仅用于发布；客户端读取公开仓库无需登录。

MinGit来源及固定SHA256记录在workspace/mingit-source.json；许可证随runtime/git/LICENSE.txt分发，对应源码位于该官方发行标签：https://github.com/git-for-windows/git 。
