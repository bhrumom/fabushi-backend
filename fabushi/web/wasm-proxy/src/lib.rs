use wasm_bindgen::prelude::*;
use js_sys::{Array, Uint8Array};
use web_sys::{console, WebSocket};
use serde::{Serialize, Deserialize};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[derive(Serialize, Deserialize)]
struct FileData {
    name: String,
    size: u32,
    target_ip: String,
}

#[wasm_bindgen]
pub struct WasmProxy {
    websocket: Option<WebSocket>,
}

#[wasm_bindgen]
impl WasmProxy {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console::log_1(&"WASM代理初始化".into());
        Self {
            websocket: None,
        }
    }

    pub fn connect_to_relay(&mut self, relay_url: &str) -> Result<bool, JsValue> {
        let ws = WebSocket::new(relay_url)?;
        
        let onopen_callback = Closure::wrap(Box::new(move || {
            console::log_1(&"WebSocket连接已建立".into());
        }) as Box<dyn FnMut()>);
        
        ws.set_onopen(Some(onopen_callback.as_ref().unchecked_ref()));
        onopen_callback.forget();
        
        let onerror_callback = Closure::wrap(Box::new(move |e: JsValue| {
            console::log_2(&"WebSocket错误:".into(), &e);
        }) as Box<dyn FnMut(JsValue)>);
        
        ws.set_onerror(Some(onerror_callback.as_ref().unchecked_ref()));
        onerror_callback.forget();
        
        self.websocket = Some(ws);
        Ok(true)
    }

    pub fn send_file(&self, file_data_js: JsValue, file_buffer: &Uint8Array) -> Result<bool, JsValue> {
        let file_data: FileData = serde_wasm_bindgen::from_value(file_data_js)?;
        
        console::log_1(&format!("准备发送文件: {} ({} 字节) 到 {}", 
                              file_data.name, file_data.size, file_data.target_ip).into());
        
        if let Some(ws) = &self.websocket {
            if ws.ready_state() == 1 { // OPEN
                // 发送文件元数据
                let metadata = JsValue::from_serde(&file_data).unwrap();
                ws.send_with_str(&format!("META:{}", js_sys::JSON::stringify(&metadata)?))?;
                
                // 发送文件内容
                ws.send_with_u8_array(file_buffer)?;
                
                console::log_1(&"文件数据已通过WebSocket发送".into());
                return Ok(true);
            } else {
                return Err(JsValue::from_str("WebSocket未连接"));
            }
        } else {
            return Err(JsValue::from_str("WebSocket未初始化"));
        }
    }
    
    pub fn close(&self) {
        if let Some(ws) = &self.websocket {
            let _ = ws.close();
        }
    }
}

// 服务工作线程处理
#[wasm_bindgen]
pub fn init_service_worker() {
    console::log_1(&"初始化WASM服务工作线程".into());
}