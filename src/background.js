'use strict'

import { app, protocol, BrowserWindow, ipcMain, dialog } from 'electron'
import { createProtocol } from 'vue-cli-plugin-electron-builder/lib'
import installExtension, { VUEJS3_DEVTOOLS } from 'electron-devtools-installer'
import path from 'path'
import fs from 'fs'
import ffmpeg from 'fluent-ffmpeg'

const isDevelopment = process.env.NODE_ENV !== 'production'

// 保持window对象的全局引用，避免JavaScript对象被垃圾回收时，窗口被自动关闭。
let win

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { secure: true, standard: true } }
])

async function createWindow() {
  // 创建浏览器窗口
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset', // macOS 风格的标题栏
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  if (process.env.WEBPACK_DEV_SERVER_URL) {
    // 如果在开发环境，加载开发服务器URL
    await win.loadURL(process.env.WEBPACK_DEV_SERVER_URL)
    if (!process.env.IS_TEST) win.webContents.openDevTools()
  } else {
    createProtocol('app')
    // 生产环境下加载 index.html
    win.loadURL('app://./index.html')
  }
}

// 当所有窗口都被关闭时退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// 应用程序准备就绪时创建窗口
app.on('ready', async () => {
  if (isDevelopment && !process.env.IS_TEST) {
    try {
      await installExtension(VUEJS3_DEVTOOLS)
    } catch (e) {
      console.error('Vue Devtools failed to install:', e.toString())
    }
  }
  createWindow()
})

if (isDevelopment) {
  if (process.platform === 'win32') {
    process.on('message', (data) => {
      if (data === 'graceful-exit') {
        app.quit()
      }
    })
  } else {
    process.on('SIGTERM', () => {
      app.quit()
    })
  }
}

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })
  return result
})

ipcMain.handle('get-folder-info', async (event, folderPath) => {
  console.log('Reading folder:', folderPath)
  try {
    const items = await fs.promises.readdir(folderPath, { withFileTypes: true })
    console.log('Found items:', items)
    const subfolders = []

    for (const item of items) {
      if (item.isDirectory()) {
        const subfolder = {
          name: item.name,
          path: path.join(folderPath, item.name),
          videoCount: 0
        }
        
        // 获取子文件夹中的视频文件数量
        const files = await fs.promises.readdir(subfolder.path)
        subfolder.videoCount = files.filter(file => {
          const ext = path.extname(file).toLowerCase()
          return ['.mp4', '.mov', '.avi', '.mkv'].includes(ext)
        }).length

        subfolders.push(subfolder)
      }
    }

    console.log('Returning subfolders:', subfolders)
    return subfolders
  } catch (error) {
    console.error('Error reading directory:', error)
    throw error
  }
})

ipcMain.handle('start-mixing', async (event, folders) => {
  try {
    // 从每个文件夹中随机选择一个视频
    const selectedVideos = []
    for (const folder of folders) {
      const files = await fs.promises.readdir(folder.path)
      const videoFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase()
        return ['.mp4', '.mov', '.avi', '.mkv'].includes(ext)
      })
      
      if (videoFiles.length > 0) {
        const randomVideo = videoFiles[Math.floor(Math.random() * videoFiles.length)]
        selectedVideos.push(path.join(folder.path, randomVideo))
      }
    }

    // 随机打乱视频顺序
    for (let i = selectedVideos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [selectedVideos[i], selectedVideos[j]] = [selectedVideos[j], selectedVideos[i]]
    }

    if (selectedVideos.length === 0) {
      throw new Error('没有找到可用的视频文件')
    }

    // 创建输出目录
    const outputDir = path.join(app.getPath('desktop'), 'VideoMixer_Output')
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir)
    }

    const outputPath = path.join(outputDir, `mixed_${Date.now()}.mp4`)

    // 修改 ffmpeg 命令
    return new Promise((resolve, reject) => {
      // 创建一个临时文件列表
      const listPath = path.join(app.getPath('temp'), 'video_list.txt')
      const fileContent = selectedVideos.map(file => `file '${file}'`).join('\n')
      fs.writeFileSync(listPath, fileContent)

      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions('-c copy')  // 使用复制模式，不重新编码
        .output(outputPath)
        .on('progress', progress => {
          win.webContents.send('mixing-progress', {
            percent: Math.round(progress.percent),
            timemark: progress.timemark
          })
        })
        .on('end', () => {
          // 删除临时文件
          fs.unlinkSync(listPath)
          resolve(outputPath)
        })
        .on('error', (err) => {
          // 删除临时文件
          if (fs.existsSync(listPath)) {
            fs.unlinkSync(listPath)
          }
          reject(err)
        })
        .run()
    })
  } catch (error) {
    console.error('混剪失败:', error)
    throw error
  }
}) 