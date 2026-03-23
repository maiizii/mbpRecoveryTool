import os, sys, time
from common.mytRpc import MytRpc

ip=os.environ.get('MYT_RPA_IP','127.0.0.1')
port=int(os.environ.get('MYT_RPA_PORT','9083'))
package=os.environ.get('MYT_PKG','com.zhiliaoapp.musically')

api=MytRpc()
print('SDK_VERSION', api.get_sdk_version())
print('CONNECT', ip, port)
if not api.init(ip, port, 30):
    print('INIT_FAILED')
    sys.exit(2)
print('CONNECTED', api.check_connect_state())

print('STOP', package, api.stopApp(package))
time.sleep(2)
print('OPEN', package, api.openApp(package))
time.sleep(3)

out, ok = api.exec_cmd('dumpsys activity top | head -n 60')
print('DUMPSYS_OK', ok)
print(out)
