# **Sigmatek LASAL MCP Server**

An Model Context Protocol (MCP) server for automating the **Sigmatek LASAL** software suite. It enables AI coding assistants (like Gemini, Claude, or Cursor) to inspect projects, apply structural CLASS 2 or VISUDesigner HMI changes, compile, download to hardware, read/write live PLC values, and control PLC execution.  
\[\!WARNING\] **This is NOT an official Sigmatek product.** This project is currently in active development, which means bugs and unpredictable behavior are highly likely. **Do not use this on actual, active production projects** without keeping a secure copy/backup of your files, or utilizing a robust version control system (like Git) to easily revert unwanted changes.

## **Features**

* **Project Navigation**: Select the active project directory and auto-resolve .lcp and .lvp paths.  
* **CLASS 2 Automation**:  
  * Inspect project structure (classes, networks, connections, server/client channels).  
  * Open and close the CLASS 2 IDE.  
  * Apply structural edits (create/delete/rename networks, add/remove/rename objects, connect/disconnect channels, set init values).  
  * Read and write class .st source files directly.  
  * Compile projects and read compiler logs (errors and warnings).  
* **VISUDesigner Automation**:  
  * Inspect HMI projects (stations, datapoints, text lists, schemes).  
  * Open and close VISUDesigner.  
  * Apply changes headlessly (sync datapoints, edit properties, configure schemes, manage media assets, add code modules).  
  * CSV translation import and export.  
* **PLC Runtime & Live Connection**:  
  * Configure target online IP addresses.  
  * Download projects to the target PLC or HMI.  
  * Read and write live channel values from a running PLC.  
  * Start, stop, or query the current PLC runtime state.

## **Prerequisites**

* **Windows OS** (Sigmatek LASAL suite runs exclusively on Windows).  
* **Node.js** (v18 or higher recommended).  
* **Sigmatek LASAL Suite**:  
  * **LASAL CLASS 2** (for PLC engineering).  
  * **VISUDesigner** (for HMI design).

## **Installation & Setup**

1. **Clone the repository**:  
   git clone \<repository-url\>  
   cd Lasal-MCP

2. **Install dependencies**:  
   npm install

3. **Build the server**:  
   npm run build

## **Configuration**

### **Environment Variables**

If Sigmatek LASAL is installed in non-standard paths, configure them using the following environment variables:

* LASAL\_CLASS2\_EXE: Full path to Lasal2.exe (Defaults to C:\\Program Files (x86)\\Sigmatek\\Lasal\\Class2\\Bin\\Lasal2.exe).  
* LASAL\_VISUDESIGNER\_EXE: Full path to VISUDesigner.exe (Defaults to C:\\Program Files\\Sigmatek\\Lasal\\VISUDesigner\\VISUDesigner.exe).

### **Connecting to MCP Clients**

#### **Claude Desktop**

Add the following config to your %APPDATA%\\Claude\\claude\_desktop\_config.json:  
{  
  "mcpServers": {  
    "lasal-mcp": {  
      "command": "node",  
      "args": \[  
        "C:/path/to/Lasal-MCP/dist/server.js"  
      \],  
      "env": {  
        "LASAL\_CLASS2\_EXE": "C:\\\\Program Files (x86)\\\\Sigmatek\\\\Lasal\\\\Class2\\\\Bin\\\\Lasal2.exe",  
        "LASAL\_VISUDESIGNER\_EXE": "C:\\\\Program Files\\\\Sigmatek\\\\Lasal\\\\VISUDesigner\\\\VISUDesigner.exe"  
      }  
    }  
  }  
}

## **Available Tools**

| Tool Name | Description |
| :---- | :---- |
| select\_project | Set the active project root directory path. |
| open\_class2 / close\_class2 | Open or close the LASAL CLASS 2 IDE. |
| open\_visudesigner / close\_visudesigner | Open or close the VISUDesigner HMI editor. |
| inspect\_project | Get structural details of networks, classes, objects, and connections. |
| inspect\_visu\_project | Get HMI details of stations, datapoints, schemes, and languages. |
| read\_class\_source / write\_class\_source | Read or write raw Structured Text (.st) code for classes. |
| apply\_project\_changes | Perform structural modifications (creating networks, instantiating classes). |
| apply\_visu\_changes | Modify HMI elements, CSV translations, media files, and schemes. |
| compile\_project | Compile the PLC project. |
| set\_target\_ip | Set the online target IP address. |
| download\_project / download\_visu\_project | Download PLC runtime or HMI visualisation to hardware. |
| get\_plc\_state / start\_plc / stop\_plc | Monitor and control PLC runtime state. |
| read\_plc\_values / write\_plc\_values | Query or update live channel values on the PLC. |
| deploy\_all | Sequence compilation, PLC download, HMI update, and HMI download in one call. |

## **Development**

* Run in developer mode (watch mode):  
  npm run dev

* Use the MCP Inspector to debug and test tools interactively:  
  npm run inspector  
