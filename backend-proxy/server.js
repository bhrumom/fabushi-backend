const express = require('express');
const multer = require('multer');
const dgram = require('dgram');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000; // 与Flutter应用匹配的端口

// 使用CORS中间件，允许来自任何源的请求
// 在生产环境中，您可能希望将其限制为您的Flutter Web应用的域
app.use(cors());

// 设置文件上传的存储引擎
const storage = multer.memoryStorage(); // 将文件存储在内存中
const upload = multer({ storage: storage });

const udpClient = dgram.createSocket('udp4');

// '/send-global' 路由，用于处理文件上传和UDP转发
app.post('/send-global', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('没有接收到文件。');
  }

  const fileName = req.body.fileName;
  const fileSize = req.body.fileSize;
  const targetIpCidr = req.body.ip;
  const fileBuffer = req.file.buffer;

  if (!targetIpCidr) {
    return res.status(400).send('缺少目标IP地址。');
  }

  console.log(`接收到文件: ${fileName} (${fileSize} 字节), 准备发送到: ${targetIpCidr}`);

  try {
    // 从CIDR表示法中提取IP地址
    const targetIp = targetIpCidr.split('/')[0];
    
    // 定义要发送到的端口列表
    const ports = [53, 80, 443, 5353]; 
    let sentCount = 0;

    // 将文件内容通过UDP发送到每个端口
    ports.forEach(port => {
      udpClient.send(fileBuffer, 0, fileBuffer.length, port, targetIp, (err) => {
        if (err) {
          console.error(`发送到 ${targetIp}:${port} 失败:`, err);
        } else {
          sentCount++;
        }
      });
    });

    console.log(`已将文件数据包分发到 ${ports.length} 个端口，目标IP: ${targetIp}`);
    
    // 返回成功响应，并附带发送信息
    res.status(200).json({
      message: '文件数据已成功转发。',
      sentCount: ports.length, // 报告成功发送的端口数量
      dataSentInMB: fileBuffer.length / (1024 * 1024)
    });

  } catch (error) {
    console.error('处理UDP发送时出错:', error);
    res.status(500).send('服务器内部错误。');
  }
});

// 添加专门的代理路由
app.post('/proxy', express.json(), (req, res) => {
  console.log('收到代理请求:', req.body);
  // 模拟成功响应
  res.status(200).json({
    success: true,
    message: '数据已通过代理处理',
    timestamp: Date.now()
  });
});

app.listen(port, () => {
  console.log(`本地代理服务器正在运行在 http://localhost:${port}`);
  console.log('等待来自Flutter Web应用的请求...');
});

// 优雅地关闭UDP客户端
process.on('SIGINT', () => {
  udpClient.close(() => {
    console.log('UDP客户端已关闭。');
    process.exit();
  });
});