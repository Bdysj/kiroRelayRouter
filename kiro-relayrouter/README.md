# RelayRouter

**为 Kiro IDE 提供简洁、稳定的 AI 模型连接体验。**  
**A simple and reliable AI model connectivity experience for Kiro IDE.**

RelayRouter 是一款独立开发的 Kiro IDE 扩展。

安装后，只需使用服务提供方分配的访问 Token 登录，即可获取当前可用的 AI 模型，并直接在 Kiro Agent 中选择模型进行开发。

RelayRouter is an independently developed extension for Kiro IDE.

After installation, simply sign in with the access token provided by your service provider. RelayRouter will load the AI models available to your account, allowing you to select and use them directly within Kiro Agent.


## 主要功能 | Features

### Token 登录 | Token Sign-In

输入访问 Token 即可完成 RelayRouter 登录，无需进行复杂的服务配置。

访问 Token 使用 Kiro IDE 提供的安全凭据存储机制进行保存，不会在普通设置界面中以明文显示。

Sign in to RelayRouter using your access token without configuring complex service settings.

Your access token is stored using the secure credential storage available in Kiro IDE and is not displayed in plain text in normal settings views.


### 模型选择 | Model Selection

登录成功后，RelayRouter 会自动获取当前 Token 可用的模型。

选择模型后，即可直接通过 Kiro Agent 开始开发。

Once signed in, RelayRouter automatically loads the models available to the current access token.

Select an available model and continue working directly with Kiro Agent.


### 流式连接 | Streaming Connectivity

RelayRouter 为模型请求提供连接支持，并兼容 Kiro Agent 的流式交互体验。

RelayRouter provides model connectivity while supporting the streaming interaction experience used by Kiro Agent.


### 积分状态 | Points Balance

登录后可以查看当前 Token 的剩余积分，方便了解当前服务的可用状态。

After signing in, you can view the remaining points associated with your access token and keep track of service availability.


### 多窗口使用 | Multi-Window Support

同一设备上的多个 Kiro IDE 窗口可以共享 RelayRouter 的本地登录与连接状态。

登录、退出或更换 Token 后，相关窗口会自动同步连接状态。

Multiple Kiro IDE windows on the same device can share RelayRouter's local sign-in and connection state.

When you sign in, sign out, or change your access token, the related windows automatically synchronize their connection state.


## 快速开始 | Getting Started

### 1. 安装 RelayRouter | Install RelayRouter

在 Kiro IDE 中安装 RelayRouter 扩展。

Install the RelayRouter extension in Kiro IDE.


### 2. 打开 RelayRouter | Open RelayRouter

安装完成后，从 Kiro IDE 的活动栏打开 **RelayRouter**。

After installation, open **RelayRouter** from the Kiro IDE activity bar.


### 3. 输入 Token | Enter Your Token

输入服务提供方提供的访问 Token，然后点击 **保存并登录**。

Enter the access token provided by your service provider and select **Save and Sign In**.


### 4. 选择模型 | Select a Model

登录成功后，选择当前可用的 AI 模型。

Once signed in, select one of the available AI models.


### 5. 使用 Kiro Agent | Start Using Kiro Agent

完成连接后，即可像平常一样使用 Kiro Agent 进行代码编写、分析和开发工作。

Once connected, continue using Kiro Agent for coding, analysis, and development as usual.


## 登录状态 | Account Status

RelayRouter 登录后可以查看当前服务状态，包括：

- 当前登录状态
- Token 有效期
- 剩余积分
- 当前可用模型
- 当前选择的模型

After signing in, RelayRouter displays essential service information including:

- Sign-in status
- Token expiration
- Remaining points
- Available models
- Currently selected model


## 退出登录 | Sign Out

你可以随时从 RelayRouter 中退出当前 Token。

退出后，RelayRouter 会清除当前登录状态，并停止通过 RelayRouter 提供模型连接。

You can sign out of the current access token at any time.

After signing out, RelayRouter clears the current sign-in state and stops providing model connectivity through RelayRouter.


## 运行要求 | Requirements

使用 RelayRouter 需要：

- Kiro IDE
- RelayRouter 扩展
- 有效的 RelayRouter 访问 Token
- 可用的 RelayRouter 服务

RelayRouter requires:

- Kiro IDE
- The RelayRouter extension
- A valid RelayRouter access token
- An available RelayRouter service


## 独立项目声明 | Independent Project Notice

RelayRouter 是独立开发的第三方扩展，并非 Amazon Web Services, Inc. 或其关联公司的产品。

RelayRouter 与 Amazon Web Services (AWS) 或 Kiro 不存在隶属、赞助、官方认可或其他官方关联。

本文档中对 “Kiro” 和 “Kiro Agent” 的引用仅用于说明 RelayRouter 的兼容环境和使用方式。

Kiro 及相关商标归其各自权利人所有。

RelayRouter is an independently developed third-party extension and is not a product of Amazon Web Services, Inc. or its affiliates.

RelayRouter is not affiliated with, sponsored by, endorsed by, or officially associated with Amazon Web Services (AWS) or Kiro.

References to “Kiro” and “Kiro Agent” are used solely to describe RelayRouter's compatibility and intended operating environment.

Kiro and related trademarks are the property of their respective owners.


---

**RelayRouter — Connect. Select. Build.**

**RelayRouter — 连接模型，专注开发。**